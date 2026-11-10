import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import { ASSETS } from '../ledger/amount';
import type { Envelope, OrderClosedV1, TradeExecutedV1 } from '../contracts/events';
import { SettleTradeDto } from '../trades/dto/settle-trade.dto';

/** Подію неможливо обробити за жодної кількості повторів. */
export class InvalidEventError extends Error {}

export type SettlementEvent =
  | { type: 'trade.executed'; trade: SettleTradeDto; traceId?: string; traceparent?: string }
  | { type: 'order.closed'; closed: OrderClosedV1 };

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function parseSettlementEvent(raw: string | undefined): SettlementEvent {
  let envelope: Envelope<Record<string, unknown>>;
  try {
    envelope = JSON.parse(raw ?? '');
  } catch {
    throw new InvalidEventError('Envelope is not valid JSON');
  }
  if (!envelope || typeof envelope !== 'object' || !isRecord(envelope.payload))
    throw new InvalidEventError('Envelope has no payload');
  if (envelope.version !== 1) throw new InvalidEventError('Unsupported event version');
  if (envelope.producer !== 'matching-engine' || !isUUID(envelope.eventId))
    throw new InvalidEventError('Envelope has an unknown producer or event ID');

  if (envelope.type === 'trade.executed') {
    const payload = envelope.payload as unknown as TradeExecutedV1;
    const trade = plainToInstance(SettleTradeDto, {
      tradeId: payload.tradeId,
      instrument: payload.instrument,
      buyOrderId: payload.buyOrderId,
      sellOrderId: payload.sellOrderId,
      buyerUserId: payload.buyerUserId,
      sellerUserId: payload.sellerUserId,
      baseAsset: payload.baseAsset,
      quoteAsset: payload.quoteAsset,
      price: payload.price,
      quantity: payload.quantity,
      buyLimitPrice: payload.buyLimitPrice,
      executedAt: payload.executedAt,
    });
    if (validateSync(trade).length) throw new InvalidEventError('Trade payload is invalid');
    return {
      type: 'trade.executed',
      trade,
      traceId: TRACEPARENT.exec(envelope.traceparent ?? '')?.[1],
      traceparent: envelope.traceparent,
    };
  }
  if (envelope.type === 'order.closed') {
    const closed = envelope.payload as unknown as OrderClosedV1;
    if (
      !isUUID(closed.orderId) ||
      !isUUID(closed.userId) ||
      !(ASSETS as readonly string[]).includes(closed.releasedAsset) ||
      typeof closed.releasedAmount !== 'string' ||
      !/^[1-9][0-9]{0,37}$/.test(closed.releasedAmount)
    )
      throw new InvalidEventError('Order close payload is invalid');
    return { type: 'order.closed', closed };
  }
  throw new InvalidEventError('Unknown event type');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
