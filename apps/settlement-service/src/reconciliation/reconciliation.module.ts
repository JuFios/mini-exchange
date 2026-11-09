import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { EngineOrdersClient } from './engine-orders.client';
import { EngineTradesClient } from './engine-trades.client';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [SecurityModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, EngineTradesClient, EngineOrdersClient],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
