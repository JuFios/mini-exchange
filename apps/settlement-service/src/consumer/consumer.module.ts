import { Module } from '@nestjs/common';
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

@Module({
  imports: [LedgerModule, TradesModule, ReservationsModule, WalletsModule, SecurityModule],
  controllers: [QueueController, MetricsController],
  providers: [SettlementConsumer, SettlementEventHandler, SettlementStats],
})
export class ConsumerModule {}
