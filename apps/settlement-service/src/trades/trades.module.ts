import { OutboxModule } from '../consumer/outbox.module';
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';

@Module({
  imports: [OutboxModule, LedgerModule],
  controllers: [TradesController],
  providers: [TradesService],
  exports: [TradesService],
})
export class TradesModule {}
