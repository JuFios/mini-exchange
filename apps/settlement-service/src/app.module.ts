import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TradesModule } from './trades/trades.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), TradesModule],
  controllers: [HealthController],
})
export class AppModule {}
