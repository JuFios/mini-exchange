import { ApiError, errorMessage } from './client-api';

export interface ReconciliationNotice {
  message: string;
  /** `false` — звірка не зламалась, а ще триває: це стан, а не помилка. */
  failed: boolean;
}

/**
 * Стан панелі, коли звірку не вдалося отримати. Сервер виконує одну звірку за раз і не зупиняє
 * її, коли сторінку закрито, тож повторне відкриття під час довгої звірки отримує 409.
 */
export function reconciliationNotice(error: unknown): ReconciliationNotice {
  if (error instanceof ApiError && error.status === 409) {
    return {
      message:
        'Звірка вже виконується: її запустило попереднє відкриття сторінки або інша вкладка. Оновіть сторінку, коли вона завершиться.',
      failed: false,
    };
  }
  // 502–504 означають обрив довгої звірки або недоступний сервіс, а не відмову за правами.
  if (error instanceof ApiError && [502, 503, 504].includes(error.status)) {
    return {
      message: 'Звірка триває довше за очікуване або сервіс недоступний. Оновіть сторінку пізніше.',
      failed: true,
    };
  }
  return { message: errorMessage(error), failed: true };
}
