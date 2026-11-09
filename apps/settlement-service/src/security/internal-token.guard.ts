import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService) {
    this.expected = hash(config.getOrThrow<string>('INTERNAL_API_TOKEN'));
  }

  canActivate(context: ExecutionContext): boolean {
    const token = context.switchToHttp().getRequest<Request>().headers['x-internal-token'];
    if (typeof token !== 'string' || !timingSafeEqual(hash(token), this.expected))
      throw new UnauthorizedException();
    return true;
  }
}
