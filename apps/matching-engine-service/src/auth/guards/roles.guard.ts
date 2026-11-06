import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export type Role = 'admin';
export const Roles = Reflector.createDecorator<Role[]>();

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: { roles?: Role[] } }>();
    return required.some((role) => user?.roles?.includes(role));
  }
}
