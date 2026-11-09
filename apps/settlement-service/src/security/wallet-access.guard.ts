import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import type { Request } from 'express';

export interface WalletRequest extends Request {
  walletUserId: string;
}

@Injectable()
export class WalletAccessGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WalletRequest>();
    const header = request.headers.authorization;
    const match = header && /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) throw new UnauthorizedException();
    try {
      const claims = await this.jwt.verifyAsync<{ sub?: string; typ?: string; exp?: number }>(
        match[1],
      );
      if (claims.typ !== 'access' || !isUUID(claims.sub) || typeof claims.exp !== 'number')
        throw new Error('Invalid access claims');
      request.walletUserId = claims.sub!.toLowerCase();
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
