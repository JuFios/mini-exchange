import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { container, docker, request, token, waitReady } from './helpers';

// Посилання й сторінку «Стан системи» frontend показує лише після підтвердження ролі engine
// (`GET /auth/admin` через `engine-lb:8080`).
const frontend = 'http://engine-lb:3000';
const link = 'href="/admin/status"';
const statusPage = 'ОНОВЛЕННЯ · 2 С';
const denied = 'Сторінка доступна лише адміністратору.';
const unknown = 'Не вдалося перевірити роль адміністратора.';
const replicas = ['matching-engine-1', 'matching-engine-2'];

async function page(path: string, accessToken: string) {
  const response = await fetch(frontend + path, {
    headers: { cookie: `exchange_access=${accessToken}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: await response.text(),
  };
}

async function main() {
  const login = await request('/auth/login', 'POST', undefined, {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(login.status, 201, await login.clone().text());
  const admin = ((await login.json()) as { accessToken: string }).accessToken;
  const user = await token('register', `${randomUUID()}@system.test`, 'system-user-password');

  const adminStatus = await page('/admin/status', admin);
  const adminTrade = await page('/exchange/ABC', admin);
  const userStatus = await page('/admin/status', user);
  const userTrade = await page('/exchange/ABC', user);
  const seen = {
    adminStatus: [
      adminStatus.status,
      adminStatus.html.includes(statusPage),
      adminStatus.html.includes(denied),
    ],
    adminLink: [adminTrade.status, adminTrade.html.includes(link)],
    userStatus: [userStatus.status, userStatus.location],
    userLink: [userTrade.status, userTrade.html.includes(link)],
  };

  // Engine не відповідає: сторінка не чекає довше за дедлайн перевірки й не відкривається.
  const ids = replicas.map(container);
  let stalled: Awaited<ReturnType<typeof page>> & { ms?: number };
  try {
    for (const id of ids) docker('pause', id);
    const started = performance.now();
    stalled = await page('/admin/status', admin);
    stalled.ms = Math.round(performance.now() - started);
  } finally {
    for (const id of ids)
      if (docker('inspect', '--format', '{{.State.Status}}', id) === 'paused')
        docker('unpause', id);
  }
  for (const service of replicas) await waitReady(service);
  Object.assign(seen, {
    stalled: [stalled.status, stalled.html.includes(unknown), stalled.html.includes(statusPage)],
  });
  console.log(`admin page ${JSON.stringify(seen)} stalledMs=${stalled.ms}`);
  assert(stalled.ms < 5000, `The admin page waited ${stalled.ms} ms for a stalled engine`);
  assert.deepEqual(seen, {
    adminStatus: [200, true, false],
    adminLink: [200, true],
    userStatus: [307, `${frontend}/exchange/ABC`],
    userLink: [200, false],
    stalled: [200, true, false],
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
