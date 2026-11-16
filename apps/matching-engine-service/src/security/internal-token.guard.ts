import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const scope = request.path.startsWith('/internal/outbox/')
      ? 'OUTBOX_READ_TOKEN'
      : 'RECONCILIATION_TOKEN';
    let expected: string | undefined;
    try {
      expected = this.config.getOrThrow<string>(scope);
    } catch {
      expected = undefined;
    }
    const token = request.headers['x-internal-token'];
    if (!expected || typeof token !== 'string' || !timingSafeEqual(digest(token), digest(expected)))
      throw new UnauthorizedException();
    return true;
  }
}
