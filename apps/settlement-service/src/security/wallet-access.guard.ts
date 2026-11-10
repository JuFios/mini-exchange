import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AccessSession } from './access-session';

export interface WalletRequest extends Request {
  walletUserId: string;
}

@Injectable()
export class WalletAccessGuard implements CanActivate {
  constructor(private readonly session: AccessSession) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WalletRequest>();
    const claims = await this.session.authenticate(request.headers.authorization);
    request.walletUserId = claims.sub.toLowerCase();
    return true;
  }
}
