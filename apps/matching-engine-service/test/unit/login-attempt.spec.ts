import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthController } from '../../src/auth/auth.controller';
import type { AuthService } from '../../src/auth/auth.service';
import type { RateLimits } from '../../src/security/rate-limits';

const dto = { email: 'owner@example.test', password: 'owner-password' };

function controller(login: () => Promise<unknown>) {
  const refund = jest.fn(async () => undefined);
  const limits = { loginAttempt: jest.fn(async () => refund) };
  const auth = { login: jest.fn(login) };
  return {
    refund,
    limits,
    login: () =>
      new AuthController(auth as unknown as AuthService, limits as unknown as RateLimits).login(
        dto,
        {} as Request,
      ),
  };
}

it('keeps a wrong password counted', async () => {
  const subject = controller(async () => {
    throw new UnauthorizedException();
  });
  await expect(subject.login()).rejects.toBeInstanceOf(UnauthorizedException);
  expect(subject.limits.loginAttempt).toHaveBeenCalledWith(dto.email, {});
  expect(subject.refund).not.toHaveBeenCalled();
});

it('returns the attempt after a successful login', async () => {
  const subject = controller(async () => ({ accessToken: 'a', refreshToken: 'r' }));
  await expect(subject.login()).resolves.toEqual({ accessToken: 'a', refreshToken: 'r' });
  expect(subject.refund).toHaveBeenCalledTimes(1);
});

it('returns the attempt when the failure is not about the password', async () => {
  const subject = controller(async () => {
    throw new ServiceUnavailableException();
  });
  await expect(subject.login()).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(subject.refund).toHaveBeenCalledTimes(1);
});
