import { EntitySchema } from 'typeorm';

export const InstrumentState = new EntitySchema({
  name: 'InstrumentState',
  tableName: 'instrument_state',
  columns: {
    instrument: { type: 'varchar', primary: true },
    status: { type: 'varchar', default: 'active' },
    legacyVerified: { name: 'legacy_verified', type: 'boolean', default: true },
    ownerEpoch: { name: 'owner_epoch', type: 'bigint', default: 0 },
    ownerInstance: { name: 'owner_instance', type: 'varchar', nullable: true },
    ownerSince: { name: 'owner_since', type: 'timestamptz', nullable: true },
    recoveredAt: { name: 'recovered_at', type: 'timestamptz', nullable: true },
    lastAppliedSeq: { name: 'last_applied_seq', type: 'bigint', default: 0 },
    restingBidCount: { name: 'resting_bid_count', type: 'bigint', default: 0 },
    restingAskCount: { name: 'resting_ask_count', type: 'bigint', default: 0 },
    restingBidLots: { name: 'resting_bid_lots', type: 'numeric', precision: 38, scale: 0, default: 0 },
    restingAskLots: { name: 'resting_ask_lots', type: 'numeric', precision: 38, scale: 0, default: 0 },
    restingCount: { name: 'resting_count', type: 'bigint', default: 0 },
    restingQuantity: { name: 'resting_quantity', type: 'numeric', precision: 38, scale: 0, default: 0 },
  },
});

export const OrderRequest = new EntitySchema({
  name: 'OrderRequest',
  tableName: 'order_requests',
  columns: {
    userId: { name: 'user_id', type: 'uuid', primary: true },
    idempotencyKey: { name: 'idempotency_key', type: 'varchar', length: 64, primary: true },
    requestHash: { name: 'request_hash', type: 'varchar', length: 64 },
    orderId: { name: 'order_id', type: 'uuid', unique: true },
    status: { type: 'varchar' },
    response: { type: 'jsonb', nullable: true },
    createdAt: { name: 'created_at', type: 'timestamptz', default: () => 'now()' },
    updatedAt: { name: 'updated_at', type: 'timestamptz', default: () => 'now()' },
    releaseAttempts: { name: 'release_attempts', type: 'integer', default: 0 },
  },
});

export const OrderCommand = new EntitySchema({
  name: 'OrderCommand',
  tableName: 'order_commands',
  columns: {
    instrument: { type: 'varchar', primary: true },
    seq: { type: 'bigint', primary: true },
    type: { type: 'varchar' },
    orderId: { name: 'order_id', type: 'uuid' },
    userId: { name: 'user_id', type: 'uuid' },
    payload: { type: 'jsonb' },
    traceparent: { type: 'varchar', nullable: true },
    acceptedAt: { name: 'accepted_at', type: 'timestamptz', default: () => 'now()' },
    appliedAt: { name: 'applied_at', type: 'timestamptz', nullable: true },
    result: { type: 'jsonb', nullable: true },
  },
});

export const TradeRecord = new EntitySchema({
  name: 'TradeRecord',
  tableName: 'trades',
  columns: {
    tradeId: { name: 'trade_id', type: 'uuid', primary: true },
    instrument: { type: 'varchar' },
    seq: { type: 'bigint' },
    fillIndex: { name: 'fill_index', type: 'integer' },
    price: { type: 'numeric', precision: 18, scale: 2 },
    quantity: { type: 'numeric', precision: 18, scale: 8 },
    quoteAmount: { name: 'quote_amount', type: 'numeric', precision: 38, scale: 0 },
    buyerOrderId: { name: 'buyer_order_id', type: 'uuid' },
    sellerOrderId: { name: 'seller_order_id', type: 'uuid' },
    buyerUserId: { name: 'buyer_user_id', type: 'uuid' },
    sellerUserId: { name: 'seller_user_id', type: 'uuid' },
    takerSide: { name: 'taker_side', type: 'varchar' },
    executedAt: { name: 'executed_at', type: 'timestamptz' },
    traceId: { name: 'trace_id', type: 'varchar', nullable: true },
  },
});

export const Outbox = new EntitySchema({
  name: 'Outbox',
  tableName: 'outbox',
  columns: {
    id: { type: 'bigint', primary: true, generated: 'increment' },
    eventId: { name: 'event_id', type: 'uuid', unique: true },
    stream: { type: 'varchar' },
    type: { type: 'varchar' },
    version: { type: 'integer' },
    instrument: { type: 'varchar', nullable: true },
    seq: { type: 'bigint', nullable: true },
    payload: { type: 'jsonb' },
    traceparent: { type: 'varchar', nullable: true },
    createdAt: { name: 'created_at', type: 'timestamptz', default: () => 'now()' },
    publishedAt: { name: 'published_at', type: 'timestamptz', nullable: true },
  },
});
