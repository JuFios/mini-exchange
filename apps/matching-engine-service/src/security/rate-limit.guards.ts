import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimits } from './rate-limits';

@Injectable()
export class AuthRateGuard implements CanActivate {
  constructor(private readonly limits: RateLimits) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Ліміт входу на email списує AuthController.login: він знає, чи пароль був невірний.
    await this.limits.auth(context.switchToHttp().getRequest<Request>());
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
