import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TradesModule } from './trades/trades.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), TradesModule],
})
export class AppModule {}
