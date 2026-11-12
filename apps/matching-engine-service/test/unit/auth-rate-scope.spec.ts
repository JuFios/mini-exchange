import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from '../../src/auth/auth.controller';
import { AuthRateGuard } from '../../src/security/rate-limit.guards';

const guards = (handler: keyof AuthController): unknown[] =>
  Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype[handler]) ?? [];

it('limits sign-in and registration by client address', () => {
  expect(guards('login')).toContain(AuthRateGuard);
  expect(guards('register')).toContain(AuthRateGuard);
});

it('does not spend the shared sign-in limit on a session refresh', () => {
  expect(guards('refresh')).not.toContain(AuthRateGuard);
});
