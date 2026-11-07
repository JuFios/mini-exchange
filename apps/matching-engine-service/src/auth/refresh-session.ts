import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface RefreshClaims {
  sub: string;
  sid: string;
  typ: 'refresh';
  exp: number;
}

export function readRefreshClaims(jwt: JwtService, token: string, secret: string): RefreshClaims {
  try {
    const claims = jwt.verify<RefreshClaims>(token, { secret, algorithms: ['HS256'] });
    if (
      claims?.typ === 'refresh' &&
      isUUID(claims.sub) &&
      isUUID(claims.sid) &&
      Number.isInteger(claims.exp)
    )
      return claims;
  } catch {
    // Усі помилки перевірки токена мають однакову відповідь.
  }
  throw new UnauthorizedException('Некоректний токен оновлення');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function matchesRefreshHash(stored: string | null, actual: string): boolean {
  if (!stored) return false;
  const storedBytes = Buffer.from(stored, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return storedBytes.length === actualBytes.length && timingSafeEqual(storedBytes, actualBytes);
}
