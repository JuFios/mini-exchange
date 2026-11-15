import { HealthCheck, HealthCheckError, HealthCheckService } from '@nestjs/terminus';
import {
  backlog,
  engineMetrics,
  owner,
  settlementGroupLag,
  settlementGroupPending,
  settlementStreamLength,
  unpublished,
} from '../observability/metrics';
import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { ReservationSweeper } from '../intake/reservation-sweeper';
import { BookLoader } from '../engine/book-loader';
import { LeaseManager } from './lease-manager';
import { OwnershipCoordinator } from './ownership-coordinator';
import { ReplicaLagMonitor } from '../realtime/replica-lag.monitor';
import { OutboxRelay } from '../outbox/outbox-relay.service';

@Controller()
export class ReadinessController {
  constructor(
    private readonly source: DataSource,
    private readonly health: HealthCheckService,
    private readonly leases: LeaseManager,
    private readonly loader: BookLoader,
    private readonly ownership: OwnershipCoordinator,
    private readonly sweeper: ReservationSweeper,
    private readonly realtime: ReplicaLagMonitor,
    private readonly modules: ModuleRef,
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

  @Get('ready')
  @HealthCheck()
  async ready() {
    const check = async (key: string, probe: () => Promise<boolean> | boolean) => {
      if (
        await Promise.resolve()
          .then(probe)
          .catch(() => false)
      ) {
        return { [key]: { status: 'up' as const } };
      }
      throw new HealthCheckError('Readiness check failed', { [key]: { status: 'down' } });
    };
    try {
      await this.health.check([
        () => check('redis', () => this.leases.redisReady()),
        () => check('postgres', async () => !(await this.hasPendingMigrations())),
        () => check('realtime', () => this.realtime.healthy()),
      ]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics() {
    const states: { instrument: string; status: string; backlog: string }[] =
      await this.source.query(
        `SELECT s.instrument,s.status,(i.next_seq-s.last_applied_seq)::text AS backlog
       FROM instrument_state s JOIN instruments i ON i.symbol=s.instrument`,
      );
    const [{ count }] = await this.source.query(
      'SELECT count(*)::text FROM outbox WHERE published_at IS NULL',
    );
    unpublished.set(Number(count));
    for (const state of states) {
      const instrument = state.instrument;
      backlog.set({ instrument }, Number(state.backlog));
      const lease = this.leases.leases.get(instrument);
      owner.set({ instrument }, Number(lease !== undefined && this.leases.valid(lease)));
    }
    // Relay належить кореневому модулю; його клієнт Redis уже є в кожній репліці.
    const queue = await this.modules
      .get(OutboxRelay, { strict: false })
      .settlementQueue(states.map(({ instrument }) => instrument));
    for (const { stream, length, pending, lag } of queue) {
      settlementStreamLength.set({ stream }, length);
      settlementGroupPending.set({ stream }, pending);
      settlementGroupLag.set({ stream }, lag);
    }
    const lag = this.realtime.lag();
    return (
      [
        `engine_recovery_mismatch_total ${this.loader.recoveryMismatches}`,
        `engine_fenced_writes_total ${this.ownership.fencedWrites}`,
        `engine_lease_renew_failures_total ${this.leases.renewFailures}`,
        `reservation_release_failures_total ${this.sweeper.releaseFailures}`,
        ...states.map(
          ({ instrument }) =>
            `ws_replica_lag_seq{instrument="${instrument}"} ${lag.get(instrument) ?? 'NaN'}`,
        ),
        ...states.map(
          (s) =>
            `engine_instrument_halted{instrument="${s.instrument}"} ${Number(s.status === 'halted')}`,
        ),
      ].join('\n') +
      '\n' +
      (await engineMetrics.metrics())
    );
  }
}
