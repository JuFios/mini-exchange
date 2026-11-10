import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt } from 'passport-jwt';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { isUUID } from 'class-validator';
import { AuthService } from '../auth.service';
import type { Role } from '../guards/roles.guard';

export interface JwtPayload {
  sub: string;
  sid: string;
  email: string;
  typ: 'access';
  exp: number;
  roles?: Role[];
}

@Injectable()
export class JwtStrategy {
  private readonly secret: string;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  async authenticate(request: Request) {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(request);
    if (!token) throw new UnauthorizedException();
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.secret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException();
    }
    return accessPrincipal(payload, this.auth);
  }
}

/** Перевірка claims access-токена; спільна для HTTP і WebSocket. */
export async function accessPrincipal(payload: JwtPayload, auth: AuthService) {
  if (
    payload?.typ !== 'access' ||
    !isUUID(payload.sub) ||
    !isUUID(payload.sid) ||
    typeof payload.email !== 'string' ||
    !Number.isInteger(payload.exp)
  ) {
    throw new UnauthorizedException('Некоректний токен доступу');
  }
  if (!(await auth.isSessionActive(payload.sub, payload.sid))) {
    throw new UnauthorizedException('Сесію оновлення відкликано');
  }
  const roles: Role[] | undefined =
    Array.isArray(payload.roles) && payload.roles.includes('admin') ? ['admin'] : undefined;
  return { userId: payload.sub, email: payload.email, roles };
}
