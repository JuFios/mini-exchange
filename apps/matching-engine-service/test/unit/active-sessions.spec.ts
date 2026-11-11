import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';
import { AuthService } from '../../src/auth/auth.service';
import type { User } from '../../src/auth/entities/user.entity';

const USER = 'c703e0f9-758a-45e8-a7a8-cdd4483dc4eb';
const SID = '6f0b0c5e-1f3c-4c39-9a52-0d1a3bfc2f10';

function service(connect: () => Promise<unknown>) {
  const users = {
    manager: { connection: { driver: { master: { connect } } } },
  } as unknown as Repository<User>;
  return new AuthService(users, {} as JwtService, {} as ConfigService);
}

it('destroys the pool client of a query abandoned at the deadline', async () => {
  const client = { query: () => new Promise(() => undefined), release: jest.fn() };
  const deadline = new AbortController();
  const result = service(async () => client).activeSessions(
    [{ userId: USER, sid: SID }],
    deadline.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  deadline.abort();
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(client.release).toHaveBeenCalledWith(true);
  void result.catch(() => undefined);
});

it('returns a late pool client unused and keeps it in the pool', async () => {
  const client = { query: jest.fn(), release: jest.fn() };
  let hand!: (value: unknown) => void;
  const deadline = new AbortController();
  const result = service(() => new Promise((resolve) => (hand = resolve))).activeSessions(
    [{ userId: USER, sid: SID }],
    deadline.signal,
  );
  deadline.abort();
  hand(client);
  await expect(result).rejects.toThrow();
  expect(client.query).not.toHaveBeenCalled();
  expect(client.release).toHaveBeenCalledWith();
});

it('reads active sessions and releases the client normally', async () => {
  const client = {
    query: async () => ({
      rows: [
        { id: USER, refresh_session_id: SID },
        { id: '0d2f6a4e-7c1b-4a8e-9f3d-5b6c7d8e9f01', refresh_session_id: null },
      ],
    }),
    release: jest.fn(),
  };
  const active = await service(async () => client).activeSessions(
    [{ userId: USER.toUpperCase(), sid: SID }],
    new AbortController().signal,
  );
  expect([...active]).toEqual([`${USER}:${SID}`]);
  expect(client.release).toHaveBeenCalledWith();
});
