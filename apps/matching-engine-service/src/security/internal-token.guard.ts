import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly expected?: Buffer;

  constructor(config: ConfigService) {
    // Без налаштованого токена внутрішні маршрути закриті для всіх.
    let token: string | undefined;
    try {
      token = config.getOrThrow<string>('INTERNAL_API_TOKEN');
    } catch {
      token = undefined;
    }
    this.expected = token === undefined ? undefined : digest(token);
  }

  canActivate(context: ExecutionContext): boolean {
    const token = context.switchToHttp().getRequest<Request>().headers['x-internal-token'];
    // Порівняння хешів однакової довжини не кидає виняток для токена будь-якої довжини.
    if (
      !this.expected ||
      typeof token !== 'string' ||
      !timingSafeEqual(digest(token), this.expected)
    )
      throw new UnauthorizedException();
    return true;
  }
}
