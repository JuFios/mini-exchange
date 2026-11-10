import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { ledgerApp } from '../ledger-app';

const ledger = ledgerApp();

it('protects every registered admin route with authentication and an admin role', async () => {
  const jwt = new JwtService({ secret: ledger.jwtSecret });
  const user = jwt.sign(
    { sub: randomUUID(), sid: randomUUID(), typ: 'access' },
    { expiresIn: '15m' },
  );
  const refresh = jwt.sign(
    { sub: randomUUID(), typ: 'refresh', roles: ['admin'] },
    { expiresIn: '15m' },
  );
  const admin = jwt.sign(
    { sub: randomUUID(), sid: randomUUID(), typ: 'access', roles: ['admin'] },
    { expiresIn: '15m' },
  );
  const server = ledger.app().getHttpServer();
  const router = ledger.app().getHttpAdapter().getInstance() as {
    _router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  };
  const routes = router._router.stack.flatMap((layer) =>
    layer.route?.path.startsWith('/admin') ? [layer.route] : [],
  );
  expect(routes.map(({ path }) => path).sort()).toEqual(['/admin/queue', '/admin/reconciliation']);
  for (const route of routes)
    for (const method of Object.keys(route.methods) as ('get' | 'post')[]) {
      await request(server)[method](route.path).expect(401);
      await request(server)[method](route.path).auth('garbage', { type: 'bearer' }).expect(401);
      await request(server)[method](route.path).auth(refresh, { type: 'bearer' }).expect(401);
      await request(server)[method](route.path).auth(user, { type: 'bearer' }).expect(403);
      // Адміністратор проходить guard; далі відповідь залежить від маршруту.
      const response = await request(server)[method](route.path).auth(admin, { type: 'bearer' });
      expect([401, 403]).not.toContain(response.status);
    }
});
