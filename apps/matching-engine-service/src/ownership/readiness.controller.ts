import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReservationSweeper } from '../intake/reservation-sweeper';
import { BookLoader } from '../engine/book-loader';
import { LeaseManager } from './lease-manager';
import { OwnershipCoordinator } from './ownership-coordinator';

@Controller()
export class ReadinessController {
  constructor(
    private readonly source: DataSource,
    private readonly leases: LeaseManager,
    private readonly loader: BookLoader,
    private readonly ownership: OwnershipCoordinator,
    private readonly sweeper: ReservationSweeper,
  ) {}

  // showMigrations() створює таблицю міграцій і не звільняє з’єднання після помилки.
  private async hasPendingMigrations(): Promise<boolean> {
    const table = this.source.options.migrationsTableName ?? 'migrations';
    const [{ exists }] = await this.source.query('SELECT to_regclass($1) IS NOT NULL AS exists', [
      `"${table}"`,
    ]);
    if (!exists) return true;
    const rows: { name: string }[] = await this.source.query(`SELECT name FROM "${table}"`);
    const applied = new Set(rows.map(({ name }) => name));
    return this.source.migrations.some(
      (migration) => !applied.has(migration.name ?? migration.constructor.name),
    );
  }

  @Get('ready') async ready() {
    try {
      const [redisReady, pending] = await Promise.all([
        this.leases.redisReady(),
        this.hasPendingMigrations(),
      ]);
      if (!redisReady || pending) throw new Error();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics() {
    const states: { instrument: string; status: string }[] = await this.source.query(
      'SELECT instrument,status FROM instrument_state',
    );
    return (
      [
        `engine_recovery_mismatch_total ${this.loader.recoveryMismatches}`,
        `engine_fenced_writes_total ${this.ownership.fencedWrites}`,
        `engine_lease_renew_failures_total ${this.leases.renewFailures}`,
        `reservation_release_failures_total ${this.sweeper.releaseFailures}`,
        ...states.map(
          (s) =>
            `engine_instrument_halted{instrument="${s.instrument}"} ${Number(s.status === 'halted')}`,
        ),
      ].join('\n') + '\n'
    );
  }
}
