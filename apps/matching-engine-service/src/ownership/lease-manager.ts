import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { RedisLockService } from '../locks/redis-lock.service';
import { FencedOutError } from './fencing';

export interface InstrumentLease {
  instrument: string;
  key: string;
  value: string;
  renewedAt: number;
  active: boolean;
  renewal?: NodeJS.Timeout;
  deadline?: NodeJS.Timeout;
}

@Injectable()
export class LeaseManager implements OnModuleDestroy {
  readonly locks: RedisLockService;
  readonly leases = new Map<string, InstrumentLease>();
  readonly lost = new Set<(instrument: string) => void>();
  readonly beforeShutdown = new Set<() => Promise<void>>();
  private readonly nextAttempt = new Map<string, number>();
  private readonly logger = new Logger(LeaseManager.name);
  private stopped = false;
  renewFailures = 0;

  constructor(private readonly config: ConfigService) {
    // Життєвий цикл клієнта належить manager: спершу drain, потім release і disconnect.
    this.locks = new RedisLockService(config);
  }

  valid(lease: InstrumentLease): boolean {
    if (lease.active && performance.now() - lease.renewedAt >= this.budget()) this.drop(lease);
    return lease.active && this.leases.get(lease.instrument) === lease;
  }

  assert(lease: InstrumentLease): void {
    if (!this.valid(lease)) throw new FencedOutError();
  }

  private budget(): number {
    return (
      this.config.getOrThrow<number>('LEASE_TTL_MS') -
      this.config.getOrThrow<number>('LEASE_SAFETY_MS')
    );
  }

  async acquire(instrument: string): Promise<InstrumentLease | undefined> {
    const current = this.leases.get(instrument);
    if (current && this.valid(current)) return current;
    if (this.stopped || performance.now() < (this.nextAttempt.get(instrument) ?? 0)) return;
    this.nextAttempt.set(
      instrument,
      performance.now() +
        this.config.getOrThrow<number>('ACQUIRE_INTERVAL_MS') +
        Math.random() * 300,
    );
    const started = performance.now();
    const lease: InstrumentLease = {
      instrument,
      key: `lease:instrument:{${instrument}}`,
      value: `${this.config.getOrThrow<string>('INSTANCE_ID')}:${randomUUID()}`,
      renewedAt: started,
      active: false,
    };
    try {
      if (!(await this.locks.acquire(lease.key, lease.value))) return;
      if (this.stopped || performance.now() - started >= this.budget()) {
        await this.locks.release(lease.key, lease.value);
        return;
      }
      lease.active = true;
      this.leases.set(instrument, lease);
      this.schedule(lease);
      return lease;
    } catch (error) {
      // Відповідь SET NX могла загубитися після застосування: ключ без власника блокує всіх до TTL.
      if (!lease.active) void this.locks.release(lease.key, lease.value).catch(() => undefined);
      this.logger.warn({
        alert: 'engine_lease_acquire_failed',
        instrument,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }
  }

  private schedule(lease: InstrumentLease, attemptStartedAt = performance.now()): void {
    clearTimeout(lease.deadline);
    clearTimeout(lease.renewal);
    lease.deadline = setTimeout(
      () => this.drop(lease),
      Math.max(0, lease.renewedAt + this.budget() - performance.now()),
    );
    // Інтервал рахується від початку спроби: повільна відповідь не відсуває повтор.
    const interval = this.config.getOrThrow<number>('LEASE_RENEW_INTERVAL_MS');
    lease.renewal = setTimeout(
      () => {
        void this.renew(lease);
      },
      Math.max(0, attemptStartedAt + interval - performance.now()),
    );
  }

  private async renew(lease: InstrumentLease): Promise<void> {
    if (!this.valid(lease)) return;
    const started = performance.now();
    try {
      const renewed = await this.locks.renew(lease.key, lease.value);
      if (!this.valid(lease)) return;
      if (renewed !== 1) {
        this.renewFailures++;
        this.drop(lease);
        return;
      }
      lease.renewedAt = started;
    } catch {
      this.renewFailures++;
      this.logger.warn({ alert: 'engine_lease_renew_failed', instrument: lease.instrument });
    }
    if (this.valid(lease)) this.schedule(lease, started);
  }

  drop(lease: InstrumentLease): void {
    if (!lease.active) return;
    lease.active = false;
    clearTimeout(lease.renewal);
    clearTimeout(lease.deadline);
    if (this.leases.get(lease.instrument) === lease) {
      this.leases.delete(lease.instrument);
      for (const listener of this.lost) listener(lease.instrument);
    }
    void this.locks.release(lease.key, lease.value).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.beforeShutdown].map((stop) => stop()));
    const leases = [...this.leases.values()];
    for (const lease of leases) this.drop(lease);
    await Promise.all(
      leases.map((lease) => this.locks.release(lease.key, lease.value).catch(() => undefined)),
    );
    await this.locks.onModuleDestroy();
  }
}
