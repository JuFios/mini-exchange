import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { bearerToken } from '../bearer-token';
import { accessPrincipal } from '../access-principal';
export { accessPrincipal } from '../access-principal';
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
    const token = bearerToken(request.headers.authorization);
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
