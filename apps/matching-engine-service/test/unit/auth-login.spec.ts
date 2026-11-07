import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../../src/auth/auth.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn(async () => 'absent-account-hash'),
  compare: jest.fn(async () => false),
}));

const compare = bcrypt.compare as unknown as jest.Mock;

function service(user: object | null) {
  const users = { findOneBy: jest.fn(async () => user) };
  const config = new ConfigService({ ADMIN_EMAILS: ['admin@example.test'] });
  return new AuthService(users as never, new JwtService(), config);
}

beforeEach(() => compare.mockClear());

it('spends a password comparison on an unknown email, as it does for a known one', async () => {
  await expect(
    service(null).login({ email: 'nobody@example.test', password: 'password-1234' }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  expect(compare).toHaveBeenCalledTimes(1);
  expect(compare).toHaveBeenCalledWith('password-1234', 'absent-account-hash');
});

it('compares against the stored hash for an existing account', async () => {
  await expect(
    service({ passwordHash: 'stored-hash' }).login({
      email: 'user@example.test',
      password: 'wrong-password',
    }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  expect(compare).toHaveBeenCalledWith('wrong-password', 'stored-hash');
});
