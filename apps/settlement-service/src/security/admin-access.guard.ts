import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AccessSession } from './access-session';

@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(private readonly session: AccessSession) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const claims = await this.session.authenticate(request.headers.authorization);
    if (!Array.isArray(claims.roles) || !claims.roles.includes('admin')) {
      throw new ForbiddenException();
    }
    return true;
  }
}
