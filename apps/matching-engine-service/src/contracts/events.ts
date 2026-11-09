export interface Envelope<T> {
  eventId: string;
  type: string;
  version: 1;
  instrument?: string;
  seq?: string;
  occurredAt: string;
  producer: 'matching-engine' | 'settlement';
  traceparent?: string;
  payload: T;
}

export interface TradePublicV1 {
  tradeId: string;
  instrument: string;
  seq: string;
  price: string;
  quantity: string;
  takerSide: 'buy' | 'sell';
  executedAt: string;
}

export interface TradeExecutedV1 extends TradePublicV1 {
  fillIndex: number;
  baseAsset: string;
  quoteAsset: string;
  quoteAmount: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  buyLimitPrice: string;
}

export interface OrderClosedV1 {
  orderId: string;
  userId: string;
  instrument: string;
  side: 'buy' | 'sell';
  reason: 'filled' | 'cancelled' | 'self_trade_prevented' | 'rejected';
  releasedAsset: string;
  releasedAmount: string;
  seq: string;
}

export interface BookDeltaV1 {
  instrument: string;
  seq: string;
  changes: { side: 'bid' | 'ask'; price: string; quantity: string; orders: number }[];
}

export interface OrderUpdatedV1 {
  orderId: string;
  userId: string;
  instrument: string;
  version: number;
  status: 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled';
  remainingQuantity: string;
  filledQuantity: string;
  cancelReason?: string;
}

export interface WalletUpdatedV1 {
  userId: string;
  asset: string;
  available: string;
  reserved: string;
  version: string;
  entryId: string;
}

interface EnginePayloads {
  'book.delta': BookDeltaV1;
  'trade.public': TradePublicV1;
  'trade.executed': TradeExecutedV1;
  'order.closed': OrderClosedV1;
  'order.updated': OrderUpdatedV1;
}

export type EngineEvent = {
  [Type in keyof EnginePayloads]: { type: Type; payload: EnginePayloads[Type] };
}[keyof EnginePayloads];
