import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../../src/auth/auth.service';
import { RegisterDto } from '../../src/auth/dto/register.dto';

jest.mock('bcrypt', () => ({
  hash: jest.fn(async () => 'absent-account-hash'),
  compare: jest.fn(async () => true),
}));

const compare = bcrypt.compare as unknown as jest.Mock;
const emoji = '\u{1F600}';

async function registerErrors(password: string) {
  const dto = plainToInstance(RegisterDto, { email: 'user@example.test', password });
  return (await validate(dto)).flatMap((error) => Object.values(error.constraints ?? {}));
}

function service() {
  const query = {
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => [{ email: 'user@example.test', passwordHash: 'stored-hash' }]),
  };
  const users = { createQueryBuilder: jest.fn(() => query) };
  const config = new ConfigService({ ADMIN_EMAILS: ['admin@example.test'] });
  return new AuthService(users as never, new JwtService(), config);
}

it.each([
  ['72 ASCII bytes', 'a'.repeat(72)],
  ['18 four-byte emoji', emoji.repeat(18)],
  ['36 Cyrillic letters', 'ж'.repeat(36)],
])('accepts a registration password of %s', async (_, password) => {
  expect(await registerErrors(password)).toEqual([]);
});

it.each([
  ['73 ASCII bytes', 'a'.repeat(73)],
  ['19 four-byte emoji', emoji.repeat(19)],
  ['72 ASCII bytes and one Cyrillic letter', 'a'.repeat(72) + 'ж'],
])('rejects a registration password of %s', async (_, password) => {
  expect(await registerErrors(password)).toEqual(['Пароль задовгий: щонайбільше 72 байти UTF-8']);
});

it('refuses a login password longer than bcrypt reads, even if its prefix matches', async () => {
  compare.mockClear();
  await expect(
    service().login({ email: 'user@example.test', password: emoji.repeat(18) + 'x' }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  // Порівняння все одно виконується: час відповіді не залежить від довжини пароля.
  expect(compare).toHaveBeenCalledTimes(1);
});
