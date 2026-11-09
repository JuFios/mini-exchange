import { HttpException } from '@nestjs/common';
import { InvalidEventError } from './settlement-event';

/** Хеш угоди збігся за ключем, але дані інші: грошей не рухаємо. */
export class PayloadConflictError extends Error {}

export type FailureKind = 'invalid' | 'transient' | 'other';

// Класи SQLSTATE: 08 з'єднання, 40 відкат (serialization, deadlock), 53 ресурси, 57 вимкнення/таймаут,
// 55P03 lock_timeout, 25P03 idle_in_transaction_session_timeout. Такі збої минають самі, тож запис не можна віддавати в DLQ.
const TRANSIENT_SQLSTATE = /^(08|40|53|57)|^(55P03|25P03)$/;
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const TRANSIENT_MESSAGE =
  /connection terminated|timeout exceeded|connection is closed|command timed out|stream isn't writeable|max retries per request|cannot use a pool after calling end|not queryable/i;
// Redis відповідає такими помилками, поки завантажує дані, перемикає репліку або не має місця.
const TRANSIENT_REDIS =
  /^(LOADING|READONLY|MISCONF|OOM|BUSY|TRYAGAIN|CLUSTERDOWN|MASTERDOWN|NOREPLICAS)\b/;

export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof InvalidEventError || error instanceof PayloadConflictError) return 'invalid';
  // Некоректні суми й адреси детерміновані: повтор дасть ту саму відповідь.
  if (error instanceof HttpException && error.getStatus() === 400) return 'invalid';
  const { code, driverError, message } = error as {
    code?: string;
    driverError?: { code?: string };
    message?: string;
  };
  const sqlstate = driverError?.code ?? code;
  // Від'ємний баланс означає помилку резервування, а не збій середовища.
  if (sqlstate === '23514') return 'invalid';
  if (
    (sqlstate && (TRANSIENT_SQLSTATE.test(sqlstate) || TRANSIENT_CODES.has(sqlstate))) ||
    (message && (TRANSIENT_MESSAGE.test(message) || TRANSIENT_REDIS.test(message)))
  )
    return 'transient';
  return 'other';
}
