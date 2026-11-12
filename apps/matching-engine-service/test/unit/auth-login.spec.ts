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

// Акаунти, які повертає пошук email без урахування регістру.
function service(user: object | object[] | null) {
  const accounts = user === null ? [] : Array.isArray(user) ? user : [user];
  const query = {
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => accounts),
    getExists: jest.fn(async () => accounts.length > 0),
  };
  const users = { createQueryBuilder: jest.fn(() => query) };
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
    service({ email: 'user@example.test', passwordHash: 'stored-hash' }).login({
      email: 'user@example.test',
      password: 'wrong-password',
    }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  expect(compare).toHaveBeenCalledWith('wrong-password', 'stored-hash');
});

it('finds an account whose address differs only in letter case', async () => {
  await expect(
    service({ email: 'User@Example.test', passwordHash: 'stored-hash' }).login({
      email: 'user@example.test',
      password: 'wrong-password',
    }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  expect(compare).toHaveBeenCalledWith('wrong-password', 'stored-hash');
});

it('prefers the exact address among older accounts that differ only in case', async () => {
  const accounts = [
    { email: 'user@example.test', passwordHash: 'lower-hash' },
    { email: 'User@example.test', passwordHash: 'mixed-hash' },
  ];
  await expect(
    service(accounts).login({ email: 'User@example.test', password: 'wrong-password' }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  expect(compare).toHaveBeenCalledWith('wrong-password', 'mixed-hash');

  compare.mockClear();
  await expect(
    service(accounts).login({ email: 'USER@example.test', password: 'wrong-password' }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  expect(compare).toHaveBeenCalledWith('wrong-password', 'absent-account-hash');
});
