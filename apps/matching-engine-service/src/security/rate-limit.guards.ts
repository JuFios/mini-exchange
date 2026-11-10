import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimits } from './rate-limits';

@Injectable()
export class AuthRateGuard implements CanActivate {
  constructor(private readonly limits: RateLimits) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    await this.limits.auth(request);
    const email: unknown = request.body?.email;
    if (context.getHandler().name === 'login' && typeof email === 'string' && email.length <= 254) {
      await this.limits.loginEmail(email);
    }
    return true;
  }
}

@Injectable()
export class PublicRateGuard implements CanActivate {
  constructor(private readonly limits: RateLimits) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.limits.publicRead(context.switchToHttp().getRequest<Request>());
    return true;
  }
}
