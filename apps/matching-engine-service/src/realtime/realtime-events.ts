import type {
  BookDeltaV1,
  Envelope,
  OrderUpdatedV1,
  TradePublicV1,
  WalletUpdatedV1,
} from '../contracts/events';

export type MarketEvent =
  | { type: 'book.delta'; eventId: string; payload: BookDeltaV1 }
  | { type: 'trade.public'; eventId: string; payload: TradePublicV1 };

export type UserEvent =
  | { type: 'order.updated'; eventId: string; payload: OrderUpdatedV1 }
  | { type: 'wallet.updated'; eventId: string; payload: WalletUpdatedV1 };

export type RealtimeEvent = MarketEvent | UserEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
// `seq` перетворюється на BigInt, який кидає виняток на нечисловому тексті.
const isSeq = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
// Десяткове число рядком: так цінам, кількостям і балансам лишається точність.
const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const ORDER_STATUSES = new Set(['pending', 'open', 'partially_filled', 'filled', 'cancelled']);

const isLevel = (value: unknown): boolean =>
  isRecord(value) &&
  (value.side === 'bid' || value.side === 'ask') &&
  isDecimal(value.price) &&
  isDecimal(value.quantity) &&
  isCount(value.orders);

/**
 * Поля, без яких клієнт не застосує подію. Інакше валідні ключі маршрутизації пропускали б
 * delta без `changes` (вона просувала б `seq`) чи баланс без `version` (порівняти версії неможливо).
 * Зайві поля дозволені: виробник може розширити контракт, а клієнту їх не віддають.
 */
const hasShape: Record<RealtimeEvent['type'], (p: Record<string, unknown>) => boolean> = {
  'book.delta': (p) =>
    isText(p.instrument) && isSeq(p.seq) && Array.isArray(p.changes) && p.changes.every(isLevel),
  'trade.public': (p) =>
    isText(p.tradeId) &&
    isText(p.instrument) &&
    isSeq(p.seq) &&
    isDecimal(p.price) &&
    isDecimal(p.quantity) &&
    (p.takerSide === 'buy' || p.takerSide === 'sell') &&
    isText(p.executedAt),
  'order.updated': (p) =>
    isText(p.orderId) &&
    isText(p.userId) &&
    isText(p.instrument) &&
    Number.isSafeInteger(p.version) &&
    typeof p.status === 'string' &&
    ORDER_STATUSES.has(p.status) &&
    isDecimal(p.remainingQuantity) &&
    isDecimal(p.filledQuantity) &&
    (p.cancelReason === undefined || typeof p.cancelReason === 'string'),
  // `version` гаманця перевищує 2^53, тому це ціле число рядком.
  'wallet.updated': (p) =>
    isText(p.userId) &&
    isText(p.asset) &&
    isDecimal(p.available) &&
    isDecimal(p.reserved) &&
    isSeq(p.version),
};

/** Значення поля запису stream або `undefined`, якщо такого поля немає. */
export function fieldOf(fields: readonly string[], name: string): string | undefined {
  const index = fields.indexOf(name);
  return index < 0 ? undefined : fields[index + 1];
}

/** `seq` команди з поля запису; нечисловий текст не потрапляє до `BigInt`. */
export function seqOf(fields: readonly string[]): bigint | undefined {
  const seq = fieldOf(fields, 'seq');
  return seq !== undefined && /^\d+$/.test(seq) ? BigInt(seq) : undefined;
}

/**
 * Розбирає поле `envelope` запису stream. Невідомий тип чи версія й пошкоджений запис дають
 * `undefined`: читач пропускає такий запис, а не зупиняється на ньому.
 */
export function parseEnvelope(fields: readonly string[]): RealtimeEvent | undefined {
  const raw = fieldOf(fields, 'envelope');
  if (raw === undefined) return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // `null`, число чи масив теж коректний JSON, але розібрати їх на поля не можна.
  if (!isRecord(envelope)) return undefined;
  const { type, eventId, version, payload } = envelope as Partial<Envelope<unknown>>;
  if (version !== 1 || !isText(eventId) || !isText(type) || !isRecord(payload)) return undefined;
  // `in` пропустив би `toString` та інші ключі прототипу.
  if (
    !Object.prototype.hasOwnProperty.call(hasShape, type) ||
    !hasShape[type as RealtimeEvent['type']](payload)
  )
    return undefined;
  return { type, eventId, payload } as unknown as RealtimeEvent;
}

// Нижче поля перелічені явно: нова внутрішня властивість події не потрапить до клієнта сама.

export const publicDelta = ({ instrument, seq, changes }: BookDeltaV1) => ({
  instrument,
  seq,
  // Рівні теж перелічені явно: зайве поле запису в Redis не повинно дійти до публічного клієнта.
  changes: changes.map(({ side, price, quantity, orders }) => ({ side, price, quantity, orders })),
});

export const publicTrade = ({
  instrument,
  tradeId,
  seq,
  price,
  quantity,
  takerSide,
  executedAt,
}: TradePublicV1) => ({ instrument, tradeId, seq, price, quantity, takerSide, executedAt });

export const privateOrder = ({
  orderId,
  instrument,
  version,
  status,
  remainingQuantity,
  filledQuantity,
  cancelReason,
}: OrderUpdatedV1) => ({
  orderId,
  instrument,
  version,
  status,
  remainingQuantity,
  filledQuantity,
  cancelReason,
});

export const privateWallet = ({ asset, available, reserved, version }: WalletUpdatedV1) => ({
  asset,
  available,
  reserved,
  version,
});
