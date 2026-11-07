import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
  ) {}

  @Get('ready') async ready() {
    try {
      const [ping, policy, pending] = await Promise.all([
        this.leases.locks.client.ping(),
        this.leases.locks.client.config('GET', 'maxmemory-policy'),
        this.source.showMigrations(),
      ]);
      if (ping !== 'PONG' || !Array.isArray(policy) || policy[1] !== 'noeviction' || pending)
        throw new Error();
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
        ...states.map(
          (s) =>
            `engine_instrument_halted{instrument="${s.instrument}"} ${Number(s.status === 'halted')}`,
        ),
      ].join('\n') + '\n'
    );
  }
}
