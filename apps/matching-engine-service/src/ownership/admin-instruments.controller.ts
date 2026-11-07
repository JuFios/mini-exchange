import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/guards/roles.guard';
import { PgNotifications } from '../engine/pg-notifications';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { LeaseManager } from './lease-manager';

@Controller('admin/instruments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['admin'])
export class AdminInstrumentsController {
  constructor(
    private readonly source: DataSource,
    private readonly leases: LeaseManager,
    private readonly catalog: InstrumentCatalog,
    private readonly notifications: PgNotifications,
  ) {}

  @Get() async list() {
    const rows = await this.source
      .query(`SELECT s.instrument,s.status,s.owner_instance AS "ownerInstance",
      s.owner_epoch AS epoch,s.last_applied_seq AS "lastAppliedSeq",i.next_seq AS "maxSeq",
      (i.next_seq-s.last_applied_seq)::text AS backlog,
      (SELECT max(price)::text FROM orders WHERE instrument=s.instrument AND side='buy' AND status IN ('open','partially_filled')) AS "bestBid",
      (SELECT min(price)::text FROM orders WHERE instrument=s.instrument AND side='sell' AND status IN ('open','partially_filled')) AS "bestAsk",
      (SELECT count(DISTINCT (side,price))::int FROM orders WHERE instrument=s.instrument AND status IN ('open','partially_filled')) AS levels,
      (s.resting_bid_count+s.resting_ask_count)::text AS resting,
      (SELECT count(*)::text FROM outbox WHERE instrument=s.instrument AND published_at IS NULL) AS "outboxBacklog"
      FROM instrument_state s JOIN instruments i ON i.symbol=s.instrument ORDER BY s.instrument`);
    return Promise.all(
      rows.map(async (row: { instrument: string }) => ({
        ...row,
        leaseTtlMs: await this.leases.locks.client.pttl(`lease:instrument:{${row.instrument}}`),
      })),
    );
  }

  @Post(':instrument/resume')
  @HttpCode(200)
  async resume(@Param('instrument') symbol: string) {
    const instrument = this.catalog.require(symbol);
    const ok = await this.notifications.requestResume(instrument);
    if (ok === undefined) throw new ServiceUnavailableException('Власник інструмента недоступний');
    if (!ok) throw new ConflictException({ code: 'RECOVERY_MISMATCH' });
    return { status: 'active' };
  }
}
