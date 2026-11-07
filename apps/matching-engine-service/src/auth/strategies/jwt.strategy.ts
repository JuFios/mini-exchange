import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { isUUID } from 'class-validator';
import type { Role } from '../guards/roles.guard';

export interface JwtPayload {
  sub: string;
  email: string;
  typ: 'access';
  exp: number;
  roles?: Role[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      algorithms: ['HS256'],
    });
  }

  validate(payload: JwtPayload) {
    if (
      payload?.typ !== 'access' ||
      !isUUID(payload.sub) ||
      typeof payload.email !== 'string' ||
      !Number.isInteger(payload.exp)
    ) {
      throw new UnauthorizedException('Некоректний токен доступу');
    }
    const roles: Role[] | undefined =
      Array.isArray(payload.roles) && payload.roles.includes('admin') ? ['admin'] : undefined;
    return { userId: payload.sub, email: payload.email, roles };
  }
}
