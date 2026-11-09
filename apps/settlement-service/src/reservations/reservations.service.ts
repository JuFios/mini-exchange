import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MAX_PRICE_TICKS, MAX_QUANTITY_LOTS, parseAmount } from '../ledger/amount';
import { LedgerWriter, requestHash } from '../ledger/ledger-writer';
import { PostingBuilder } from '../ledger/posting-builder';
import { WalletPublisher } from '../wallets/wallet-publisher';
import { consumeReservation, lockReservations } from './reservation-record';
import { ReserveDto } from './reserve.dto';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly source: DataSource,
    private readonly ledger: LedgerWriter,
    private readonly publisher: WalletPublisher,
  ) {}

  async reserve(dto: ReserveDto): Promise<{ status: 'accepted' | 'rejected' }> {
    const reservationId = dto.reservationId.toLowerCase();
    const wallet = { userId: dto.userId.toLowerCase(), asset: dto.asset };
    const amount = BigInt(dto.amount);
    const limit = reservationLimit(dto, amount).toString();
    const hash = requestHash({
      ...wallet,
      amount: amount.toString(),
      instrument: dto.instrument,
      limit,
    });
    const result = await this.source.transaction(async (db) => {
      const [claimed] = await db.query(
        `INSERT INTO reservations (reservation_id,user_id,asset,amount,remaining,status,request_hash,result,instrument,limit_price_ticks)
         VALUES ($1,$2,$3,$4,$4,'active',$5,'{"status":"accepted"}',$6,$7)
         ON CONFLICT (reservation_id) DO NOTHING RETURNING reservation_id`,
        [
          reservationId,
          wallet.userId,
          wallet.asset,
          amount.toString(),
          hash,
          dto.instrument,
          limit,
        ],
      );
      if (!claimed) {
        const [existing] = await lockReservations(db, [reservationId]);
        if (existing.status === 'released_tombstone') {
          throw new ConflictException({
            code: 'ALREADY_RELEASED',
            message: 'Резерв уже звільнено',
          });
        }
        if (existing.request_hash !== hash) {
          throw new ConflictException({
            code: 'RESERVATION_CONFLICT',
            message: 'Дані резерву відрізняються',
          });
        }
        return existing.result!;
      }
      const accounts = await this.ledger.lockWallets(db, [wallet]);
      if (BigInt(accounts.get({ ...wallet, kind: 'available' }).balance) < amount) {
        const rejection = { status: 'rejected' as const };
        await db.query(
          "UPDATE reservations SET remaining=0,status='rejected',result=$2 WHERE reservation_id=$1",
          [reservationId, rejection],
        );
        return rejection;
      }
      const entryId = await this.ledger.write(
        db,
        accounts,
        { operationId: `reserve:${reservationId}`, type: 'reserve', reservationId },
        PostingBuilder.transfer('reserve', wallet, amount),
      );
      return { status: 'accepted' as const, update: { ...accounts.wallet(wallet), entryId } };
    });
    if ('update' in result && result.update) await this.publisher.publishBestEffort(result.update);
    return { status: result.status };
  }

  async release(id: string, releaseAmount?: bigint): Promise<{ status: 'released' }> {
    const reservationId = id.toLowerCase();
    const update = await this.source.transaction(async (db) => {
      // Tombstone відсікає запізнілий reserve, навіть якщо engine змінив режим.
      await db.query(
        `INSERT INTO reservations (reservation_id,status) VALUES ($1,'released_tombstone')
         ON CONFLICT (reservation_id) DO NOTHING`,
        [reservationId],
      );
      const [reservation] = await lockReservations(db, [reservationId]);
      const operationId =
        releaseAmount === undefined ? `release:full:${reservationId}` : `release:${reservationId}`;
      if (releaseAmount !== undefined) {
        const [existing]: { amount: string }[] = await db.query(
          `SELECT p.amount FROM journal_entries j JOIN postings p ON p.entry_id=j.id
           WHERE j.operation_id=$1 AND p.direction='credit'`,
          [operationId],
        );
        if (existing) {
          if (BigInt(existing.amount) !== releaseAmount) throw releaseMismatch();
          return;
        }
      }
      if (reservation.status !== 'active') return;
      const wallet = { userId: reservation.user_id, asset: reservation.asset };
      const remaining = BigInt(reservation.remaining);
      const amount = releaseAmount ?? remaining;
      if (amount <= 0n || amount > remaining) throw releaseMismatch();
      const accounts = await this.ledger.lockWallets(db, [wallet]);
      const entryId = await this.ledger.write(
        db,
        accounts,
        { operationId, type: 'release', reservationId },
        PostingBuilder.transfer('release', wallet, amount),
      );
      await consumeReservation(db, reservationId, amount);
      return { ...accounts.wallet(wallet), entryId };
    });
    if (update) await this.publisher.publishBestEffort(update);
    return { status: 'released' };
  }
}

function reservationLimit(dto: ReserveDto, amount: bigint): bigint {
  try {
    const limit = parseAmount(dto.limitPrice, 2);
    if (
      limit <= 0n ||
      limit > MAX_PRICE_TICKS ||
      amount <= 0n ||
      (dto.asset === 'USD'
        ? amount % limit !== 0n || amount / limit > MAX_QUANTITY_LOTS
        : dto.asset !== dto.instrument || amount > MAX_QUANTITY_LOTS)
    )
      throw new Error();
    return limit;
  } catch {
    throw new BadRequestException('Некоректні параметри резерву');
  }
}

function releaseMismatch(): ConflictException {
  return new ConflictException({
    code: 'RESERVATION_MISMATCH',
    message: 'Сума звільнення не відповідає резерву',
  });
}
