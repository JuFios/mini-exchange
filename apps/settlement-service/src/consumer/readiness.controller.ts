import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckError, HealthCheckService } from '@nestjs/terminus';
import { DataSource } from 'typeorm';
import { SettlementConsumer } from './settlement-consumer.service';

@Controller('ready')
export class ReadinessController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly source: DataSource,
    private readonly consumer: SettlementConsumer,
  ) {}

  @Get()
  @HealthCheck()
  async check() {
    const probe = async (key: string, read: () => Promise<boolean>) => {
      if (await read().catch(() => false)) return { [key]: { status: 'up' as const } };
      throw new HealthCheckError('Readiness check failed', { [key]: { status: 'down' } });
    };
    try {
      await this.health.check([
        () => probe('postgres', () => this.migrated()),
        () => probe('redis', () => this.consumer.redisReady()),
      ]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }

  private async migrated(): Promise<boolean> {
    const table = this.source.options.migrationsTableName ?? 'migrations';
    const [{ exists }] = await this.source.query('SELECT to_regclass($1) IS NOT NULL AS exists', [
      `"${table}"`,
    ]);
    if (!exists) return false;
    const rows: { name: string }[] = await this.source.query(`SELECT name FROM "${table}"`);
    const applied = new Set(rows.map(({ name }) => name));
    return this.source.migrations.every((migration) =>
      applied.has(migration.name ?? migration.constructor.name),
    );
  }
}
