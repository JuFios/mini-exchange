import { Module } from '@nestjs/common';
import { RateLimits } from './rate-limits';
import { AuthRateGuard, OrdersWriteRateGuard, PublicRateGuard } from './rate-limit.guards';

@Module({
  providers: [RateLimits, AuthRateGuard, PublicRateGuard, OrdersWriteRateGuard],
  exports: [RateLimits, AuthRateGuard, PublicRateGuard, OrdersWriteRateGuard],
})
export class RateLimitModule {}
