import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
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
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      algorithms: ['HS256'],
    });
  }

  validate(payload: JwtPayload) {
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
