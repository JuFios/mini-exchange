import { recoverySeconds, takeovers } from '../observability/metrics';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BookLoader } from '../engine/book-loader';
import { InstrumentLease, LeaseManager } from './lease-manager';
import { lockEpoch } from './fencing';

@Injectable()
export class OwnershipCoordinator {
  private readonly epochs = new WeakMap<InstrumentLease, string>();
  private readonly logger = new Logger(OwnershipCoordinator.name);
  fencedWrites = 0;

  constructor(
    private readonly source: DataSource,
    private readonly loader: BookLoader,
    private readonly config: ConfigService,
    readonly leases: LeaseManager,
  ) {}

  async recover(instrument: string, lease: InstrumentLease, resume = false) {
    this.leases.assert(lease);
    const previous = this.epochs.get(lease);
    const stop = recoverySeconds.startTimer({ instrument });
    const recovered = await this.source.transaction(async (db) => {
      await db.query("SET LOCAL lock_timeout='3s'");
      let epoch = previous;
      if (!epoch) {
        const [[state]] = await db.query(
          `UPDATE instrument_state SET owner_epoch=owner_epoch+1,owner_instance=$2,owner_since=now()
           WHERE instrument=$1 RETURNING owner_epoch`,
          [instrument, this.config.getOrThrow('INSTANCE_ID')],
        );
        epoch = state.owner_epoch as string;
      } else await lockEpoch(db, instrument, epoch);
      const book = await this.loader.load(db, instrument, resume);
      this.leases.assert(lease);
      return { ...book, epoch, lease };
    });
    this.leases.assert(lease);
    this.epochs.set(lease, recovered.epoch);
    stop();
    if (!previous && BigInt(recovered.epoch) > 1n) takeovers.inc({ instrument });
    this.logger.log(`lease acquired instrument=${instrument} epoch=${recovered.epoch}`);
    this.logger.log(`book recovered instrument=${instrument} lastAppliedSeq=${recovered.seq}`);
    return recovered;
  }
}
