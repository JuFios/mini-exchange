import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessSession } from '../../src/security/access-session';
import { AdminAccessGuard } from '../../src/security/admin-access.guard';
import { WalletAccessGuard } from '../../src/security/wallet-access.guard';

const secret = 'a'.repeat(32);
const internalToken = 'x'.repeat(32);
const jwt = new JwtService({ secret });
let server: Server;
let requests: string[] = [];
// Відповіді engine за шляхом; за замовчуванням сесія активна, а адреса вже не адмін.
let engine: Record<string, number> = {};

const adminToken = () =>
  jwt.sign(
    { sub: randomUUID(), sid: randomUUID(), typ: 'access', roles: ['admin'] },
    { expiresIn: '15m' },
  );

function session() {
  const config = {
    getOrThrow: (key: string) =>
      ({
        ENGINE_INTERNAL_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        INTERNAL_API_TOKEN: internalToken,
      })[key],
  };
  return new AccessSession(config as never, jwt);
}

function context(token: string) {
  const request = { headers: { authorization: `Bearer ${token}` } };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    const status =
      request.headers['x-internal-token'] === internalToken ? (engine[path] ?? 404) : 401;
    response.writeHead(status).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  requests = [];
  engine = { '/internal/auth/session': 204, '/internal/auth/admin': 403 };
});

it('rejects an admin token whose address the engine no longer treats as admin', async () => {
  const guard = new AdminAccessGuard(session());
  await expect(guard.canActivate(context(adminToken()))).rejects.toBeInstanceOf(ForbiddenException);
});

it('admits an admin token only after the engine confirms the role', async () => {
  engine['/internal/auth/admin'] = 204;
  const guard = new AdminAccessGuard(session());
  await expect(guard.canActivate(context(adminToken()))).resolves.toBe(true);
  expect(requests).toEqual(['/internal/auth/admin']);
});

it('keeps a revoked session and an unavailable engine apart from a missing role', async () => {
  const guard = new AdminAccessGuard(session());
  engine['/internal/auth/admin'] = 401;
  await expect(guard.canActivate(context(adminToken()))).rejects.toBeInstanceOf(
    UnauthorizedException,
  );
  engine['/internal/auth/admin'] = 500;
  await expect(guard.canActivate(context(adminToken()))).rejects.toBeInstanceOf(
    ServiceUnavailableException,
  );
});

it('checks only the session for wallet reads, whatever the role claim says', async () => {
  const guard = new WalletAccessGuard(session());
  await expect(guard.canActivate(context(adminToken()))).resolves.toBe(true);
  expect(requests).toEqual(['/internal/auth/session']);
});
