import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';

interface AccessClaims {
  sub: string;
  sid: string;
  typ: string;
  exp: number;
  roles?: string[];
}

@Injectable()
export class AccessSession {
  private readonly endpoint: URL;
  private readonly internalToken: string;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    this.endpoint = new URL('/internal/auth/session', config.getOrThrow('ENGINE_INTERNAL_URL'));
    this.internalToken = config.getOrThrow('INTERNAL_API_TOKEN');
  }

  async authenticate(header: string | undefined): Promise<AccessClaims> {
    const match = header && /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) throw new UnauthorizedException();
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(match[1]);
    } catch {
      throw new UnauthorizedException();
    }
    if (
      claims.typ !== 'access' ||
      !isUUID(claims.sub) ||
      !isUUID(claims.sid) ||
      !Number.isInteger(claims.exp)
    ) {
      throw new UnauthorizedException();
    }
    await this.requireActive(match[1]);
    return claims;
  }

  async requireActive(token: string): Promise<void> {
    let status: number;
    try {
      const response = await fetch(this.endpoint, {
        headers: { authorization: 'Bearer ' + token, 'x-internal-token': this.internalToken },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      throw new ServiceUnavailableException('Перевірка сесії тимчасово недоступна');
    }
    if (status === 401) throw new UnauthorizedException();
    if (status !== 204) {
      throw new ServiceUnavailableException('Перевірка сесії тимчасово недоступна');
    }
  }
}
