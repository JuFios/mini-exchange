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

const MARKET_TYPES = new Set(['book.delta', 'trade.public']);
const USER_TYPES = new Set(['order.updated', 'wallet.updated']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
// `seq` перетворюється на BigInt, який кидає виняток на нечисловому тексті.
const isSeq = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

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
  // Форму payload гарантує виробник (контрактні тести); тут перевіряються лише ключі маршрутизації.
  if (MARKET_TYPES.has(type)) {
    if (!isText(payload.instrument) || !isSeq(payload.seq)) return undefined;
    return { type, eventId, payload } as unknown as MarketEvent;
  }
  if (USER_TYPES.has(type)) {
    if (!isText(payload.userId)) return undefined;
    return { type, eventId, payload } as unknown as UserEvent;
  }
  return undefined;
}

// Нижче поля перелічені явно: нова внутрішня властивість події не потрапить до клієнта сама.

export const publicDelta = ({ instrument, seq, changes }: BookDeltaV1) => ({
  instrument,
  seq,
  changes,
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
