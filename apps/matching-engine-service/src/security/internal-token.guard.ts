import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const OUTBOX_SCOPE = Symbol('outbox-token-scope');
export const OutboxTokenScope = () => SetMetadata(OUTBOX_SCOPE, true);

@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const scope = this.reflector.get<boolean>(OUTBOX_SCOPE, context.getClass())
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
