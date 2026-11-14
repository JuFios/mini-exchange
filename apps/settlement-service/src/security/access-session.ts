import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
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

export type AccessScope = 'session' | 'admin';

@Injectable()
export class AccessSession {
  private readonly endpoints: Record<AccessScope, URL>;
  private readonly internalToken: string;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    const engine = config.getOrThrow<string>('ENGINE_INTERNAL_URL');
    this.endpoints = {
      session: new URL('/internal/auth/session', engine),
      // Роль звіряє engine з поточним ADMIN_EMAILS: claim у токені живе до `exp`.
      admin: new URL('/internal/auth/admin', engine),
    };
    this.internalToken = config.getOrThrow('INTERNAL_API_TOKEN');
  }

  async authenticate(
    header: string | undefined,
    scope: AccessScope = 'session',
  ): Promise<AccessClaims> {
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
    await this.requireActive(match[1], scope);
    return claims;
  }

  async requireActive(token: string, scope: AccessScope = 'session'): Promise<void> {
    let status: number;
    try {
      const response = await fetch(this.endpoints[scope], {
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
    if (status === 403 && scope === 'admin') throw new ForbiddenException();
    if (status !== 204) {
      throw new ServiceUnavailableException('Перевірка сесії тимчасово недоступна');
    }
  }
}
