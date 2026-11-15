import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
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

@Injectable()
export class OrdersWriteRateGuard implements CanActivate {
  constructor(private readonly limits: RateLimits) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: { userId?: string } }>();
    if (!request.user?.userId) throw new UnauthorizedException();
    await this.limits.orderWrite(request.user.userId);
    return true;
  }
}
