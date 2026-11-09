import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import type { Request } from 'express';

@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization;
    const match = header && /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) throw new UnauthorizedException();
    let claims: { sub?: string; typ?: string; exp?: number; roles?: unknown };
    try {
      claims = await this.jwt.verifyAsync(match[1]);
    } catch {
      throw new UnauthorizedException();
    }
    if (claims.typ !== 'access' || !isUUID(claims.sub) || typeof claims.exp !== 'number')
      throw new UnauthorizedException();
    if (!Array.isArray(claims.roles) || !claims.roles.includes('admin'))
      throw new ForbiddenException();
    return true;
  }
}
