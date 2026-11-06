import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role, Roles, RolesGuard } from '../../src/auth/guards/roles.guard';

@Roles(['admin'])
class AdminController {
  protectedRoute() {}

  @Roles([])
  publicRoute() {}
}

const guard = new RolesGuard(new Reflector());

function context(handler: keyof AdminController, roles?: Role[]): ExecutionContext {
  return {
    getClass: () => AdminController,
    getHandler: () => AdminController.prototype[handler],
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
  } as unknown as ExecutionContext;
}

it('requires the admin role declared on a controller', () => {
  expect(guard.canActivate(context('protectedRoute'))).toBe(false);
  expect(guard.canActivate(context('protectedRoute', ['admin']))).toBe(true);
});

it('uses handler metadata before controller metadata', () => {
  expect(guard.canActivate(context('publicRoute'))).toBe(true);
});
