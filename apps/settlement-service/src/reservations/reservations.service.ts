import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
    const hash = requestHash({ ...wallet, amount: amount.toString() });
    const result = await this.source.transaction(async (db) => {
      const [claimed] = await db.query(
        `INSERT INTO reservations (reservation_id,user_id,asset,amount,remaining,status,request_hash,result)
         VALUES ($1,$2,$3,$4,$4,'active',$5,'{"status":"accepted"}')
         ON CONFLICT (reservation_id) DO NOTHING RETURNING reservation_id`,
        [reservationId, wallet.userId, wallet.asset, amount.toString(), hash],
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
      // Tombstone має виграти і тоді, коли запізнілий reserve ще не надійшов.
      await db.query(
        `INSERT INTO reservations (reservation_id,status) VALUES ($1,'released_tombstone')
         ON CONFLICT (reservation_id) DO NOTHING`,
        [reservationId],
      );
      const [reservation] = await lockReservations(db, [reservationId]);
      if (reservation.status !== 'active') return;
      const operationId = `release:${reservationId}`;
      const [existing] = await db.query('SELECT id FROM journal_entries WHERE operation_id=$1', [
        operationId,
      ]);
      if (existing) return;
      const wallet = { userId: reservation.user_id, asset: reservation.asset };
      const remaining = BigInt(reservation.remaining);
      const amount = releaseAmount ?? remaining;
      if (amount <= 0n || amount > remaining) {
        throw new ConflictException({
          code: 'RESERVATION_MISMATCH',
          message: 'Сума звільнення не відповідає резерву',
        });
      }
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
