import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Asset, MAX_PRICE_TICKS, MAX_QUANTITY_LOTS, parseAmount } from '../ledger/amount';
import { LedgerWriter, requestHash } from '../ledger/ledger-writer';
import { PostingBuilder } from '../ledger/posting-builder';
import {
  consumeReservation,
  lockReservations,
  ReservationRecord,
} from '../reservations/reservation-record';
import { SettleTradeDto } from './dto/settle-trade.dto';

@Injectable()
export class TradesService {
  constructor(
    private readonly source: DataSource,
    private readonly ledger: LedgerWriter,
  ) {}

  async settle(
    dto: SettleTradeDto,
    streamId?: string,
    traceId?: string,
  ): Promise<SettlementResult> {
    const { trade, price, quantity, buyLimit, hash } = describeTrade(dto);
    const {
      tradeId,
      instrument,
      buyOrderId,
      sellOrderId,
      buyerUserId,
      sellerUserId,
      baseAsset,
      quoteAsset,
      executedAt,
    } = trade;

    return this.source.transaction(async (db) => {
      const [inserted] = await db.query(
        `INSERT INTO settled_trades (trade_id,instrument,payload_hash,executed_at,stream_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (trade_id) DO NOTHING RETURNING trade_id`,
        [tradeId, instrument, hash, executedAt, streamId],
      );
      if (!inserted) {
        const [existing] = await db.query(
          'SELECT payload_hash,entry_id FROM settled_trades WHERE trade_id=$1',
          [tradeId],
        );
        return existing.payload_hash === hash
          ? { status: 'duplicate', entryId: existing.entry_id }
          : { status: 'conflict' };
      }
      const locked = await lockReservations(db, [buyOrderId, sellOrderId]);
      const buy = locked.find((reservation) => reservation.reservation_id === buyOrderId);
      const sell = locked.find((reservation) => reservation.reservation_id === sellOrderId);
      const buyer = tradeReservation(buy, buyerUserId, quoteAsset, instrument);
      const seller = tradeReservation(sell, sellerUserId, baseAsset, instrument);
      const reservedQuote = buyer.limit * quantity;
      if (
        buyLimit !== buyer.limit ||
        price > buyer.limit ||
        price < seller.limit ||
        buyer.remaining < reservedQuote ||
        seller.remaining < quantity
      )
        throw reservationMismatch();
      const postings = PostingBuilder.trade({
        buyerUserId,
        sellerUserId,
        baseAsset,
        quoteAsset,
        price,
        quantity,
        buyLimit: buyer.limit,
      });
      const wallets = [
        { userId: buyerUserId, asset: baseAsset },
        { userId: buyerUserId, asset: quoteAsset },
        { userId: sellerUserId, asset: baseAsset },
        { userId: sellerUserId, asset: quoteAsset },
      ];
      const accounts = await this.ledger.lockWallets(db, wallets);
      const entryId = await this.ledger.write(
        db,
        accounts,
        { operationId: `trade:${tradeId}`, type: 'trade', tradeId, traceId },
        postings,
      );
      await consumeReservation(db, buyOrderId, reservedQuote);
      await consumeReservation(db, sellOrderId, quantity);
      await db.query('UPDATE settled_trades SET entry_id=$2 WHERE trade_id=$1', [tradeId, entryId]);
      return { status: 'applied', entryId };
    });
  }
}

/** Канонічний вигляд угоди й хеш, спільні для розрахунку та звірки. */
export function describeTrade(dto: SettleTradeDto) {
  const trade = canonicalTrade(dto);
  const { price, quantity, buyLimit } = tradeAmounts(dto);
  const hash = requestHash({
    instrument: trade.instrument,
    buyOrderId: trade.buyOrderId,
    sellOrderId: trade.sellOrderId,
    buyerUserId: trade.buyerUserId,
    sellerUserId: trade.sellerUserId,
    baseAsset: trade.baseAsset,
    quoteAsset: trade.quoteAsset,
    executedAt: trade.executedAt,
    price: price.toString(),
    quantity: quantity.toString(),
    buyLimit: buyLimit.toString(),
  });
  return { trade, price, quantity, buyLimit, hash };
}

export type SettlementResult =
  { status: 'applied' | 'duplicate'; entryId: string } | { status: 'conflict' };

function canonicalTrade(dto: SettleTradeDto): SettleTradeDto {
  const trade = {
    ...dto,
    tradeId: dto.tradeId.toLowerCase(),
    buyOrderId: dto.buyOrderId.toLowerCase(),
    sellOrderId: dto.sellOrderId.toLowerCase(),
    buyerUserId: dto.buyerUserId.toLowerCase(),
    sellerUserId: dto.sellerUserId.toLowerCase(),
  };
  if (
    trade.instrument !== trade.baseAsset ||
    trade.baseAsset === 'USD' ||
    trade.quoteAsset !== 'USD' ||
    trade.buyerUserId === trade.sellerUserId ||
    trade.buyOrderId === trade.sellOrderId
  )
    throw new BadRequestException('Некоректні дані угоди');
  const date = new Date(trade.executedAt);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException('Некоректний час угоди');
  return { ...trade, executedAt: date.toISOString() };
}

function tradeAmounts(dto: SettleTradeDto) {
  try {
    const price = parseAmount(dto.price, 2);
    const buyLimit = parseAmount(dto.buyLimitPrice, 2);
    const quantity = parseAmount(dto.quantity, 8);
    if (
      price <= 0n ||
      price > buyLimit ||
      buyLimit > MAX_PRICE_TICKS ||
      quantity <= 0n ||
      quantity > MAX_QUANTITY_LOTS
    )
      throw new Error();
    return { price, quantity, buyLimit };
  } catch {
    throw new BadRequestException('Некоректні суми угоди');
  }
}

function tradeReservation(
  row: ReservationRecord | undefined,
  userId: string,
  asset: Asset,
  instrument: string,
) {
  if (
    row?.status !== 'active' ||
    row.user_id !== userId ||
    row.asset !== asset ||
    row.instrument !== instrument ||
    row.limit_price_ticks === null
  )
    throw reservationMismatch();
  return { limit: BigInt(row.limit_price_ticks), remaining: BigInt(row.remaining) };
}

function reservationMismatch(): ConflictException {
  return new ConflictException({
    code: 'RESERVATION_MISMATCH',
    message: 'Резерв не відповідає угоді',
  });
}
