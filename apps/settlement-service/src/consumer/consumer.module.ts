import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LedgerModule } from '../ledger/ledger.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { SecurityModule } from '../security/security.module';
import { TradesModule } from '../trades/trades.module';
import { WalletsModule } from '../wallets/wallets.module';
import { MetricsController } from './metrics.controller';
import { QueueController } from './queue.controller';
import { SettlementConsumer } from './settlement-consumer.service';
import { SettlementEventHandler } from './settlement-event.handler';
import { SettlementStats } from './settlement-stats';
import { ReadinessController } from './readiness.controller';

@Module({
  imports: [
    LedgerModule,
    TradesModule,
    ReservationsModule,
    WalletsModule,
    SecurityModule,
    TerminusModule,
  ],
  controllers: [QueueController, MetricsController, ReadinessController],
  providers: [SettlementConsumer, SettlementEventHandler, SettlementStats],
})
export class ConsumerModule {}
