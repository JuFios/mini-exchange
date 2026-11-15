import { Module } from '@nestjs/common';
import { RateLimits } from './rate-limits';
import { AuthRateGuard, PublicRateGuard } from './rate-limit.guards';

@Module({
  providers: [RateLimits, AuthRateGuard, PublicRateGuard],
  exports: [RateLimits, AuthRateGuard, PublicRateGuard],
})
export class RateLimitModule {}
