import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { container, docker, request, token, waitReady } from './helpers';

// Посилання й сторінку «Стан системи» frontend показує лише після підтвердження ролі engine
// (`GET /auth/admin` через `engine-lb:8080`).
const frontend = 'http://engine-lb:3000';
const link = 'href="/admin/status"';
const statusPage = 'ОНОВЛЕННЯ · 2 С';
const denied = 'Сторінка доступна лише адміністратору.';
// Engine не відповів: сторінка відкривається з попередженням, бо її дані backend віддає лише адміну.
const unverified =
  'Не вдалося перевірити роль адміністратора: engine не відповів або відповів помилкою.';
const recovering = 'Оновлюємо сесію…';
const replicas = ['matching-engine-1', 'matching-engine-2'];
// Дедлайн перевірки 1,5 с плюс рендер сторінки.
const DEADLINE_BOUND_MS = 3000;

async function page(path: string, accessToken: string) {
  const started = performance.now();
  const response = await fetch(frontend + path, {
    headers: { cookie: `exchange_access=${accessToken}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: await response.text(),
    ms: Math.round(performance.now() - started),
  };
}

const unpause = (id: string) => {
  if (docker('inspect', '--format', '{{.State.Status}}', id) === 'paused') docker('unpause', id);
};

async function adminLogin() {
  const login = await request('/auth/login', 'POST', undefined, {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(login.status, 201, await login.clone().text());
  return ((await login.json()) as { accessToken: string }).accessToken;
}

async function main() {
  const ids = replicas.map(container);
  // Прогін, убитий посеред паузи, не має ламати наступний.
  for (const id of ids) unpause(id);
  for (const service of replicas) await waitReady(service);
  const admin = await adminLogin();
  const user = await token('register', `${randomUUID()}@system.test`, 'system-user-password');

  const adminStatus = await page('/admin/status', admin);
  const adminTrade = await page('/exchange/ABC', admin);
  const userStatus = await page('/admin/status', user);
  const userTrade = await page('/exchange/ABC', user);
  const seen: Record<string, unknown[]> = {
    adminStatus: [
      adminStatus.status,
      adminStatus.html.includes(statusPage),
      adminStatus.html.includes(denied),
    ],
    adminLink: [adminTrade.status, adminTrade.html.includes(link)],
    userStatus: [userStatus.status, userStatus.location],
    userLink: [userTrade.status, userTrade.html.includes(link)],
  };

  try {
    // Одна репліка зависла: nginx має перейти на іншу раніше, ніж спливе дедлайн перевірки.
    docker('pause', ids[0]);
    const pages = [];
    for (let i = 0; i < 6; i++) pages.push(await page('/admin/status', admin));
    unpause(ids[0]);
    seen.oneStalled = [
      pages.filter(({ html }) => html.includes(statusPage) && !html.includes(unverified)).length,
    ];
    const slowest = Math.max(...pages.map(({ ms }) => ms));

    // Обидві зависли: сторінка з попередженням, посилання немає, дедлайн тримається.
    for (const id of ids) docker('pause', id);
    const stalled = await page('/admin/status', admin);
    const stalledTrade = await page('/exchange/ABC', admin);
    seen.stalled = [
      stalled.status,
      stalled.html.includes(unverified),
      stalled.html.includes(statusPage),
    ];
    seen.stalledLink = [stalledTrade.status, stalledTrade.html.includes(link)];
    console.log(
      `admin page ${JSON.stringify(seen)} oneStalledSlowestMs=${slowest} ` +
        `stalledMs=${stalled.ms} stalledTradeMs=${stalledTrade.ms}`,
    );
    for (const [name, ms] of Object.entries({ slowest, stalled: stalled.ms }))
      assert(ms < DEADLINE_BOUND_MS, `The admin page (${name}) waited ${ms} ms`);
  } finally {
    for (const id of ids) unpause(id);
  }
  for (const service of replicas) await waitReady(service);

  // Новий вхід замінює сесію: старий JWT ще чинний, але engine відповідає 401. Сторінка оновлює
  // сесію в браузері; після оновлення повторний 401 веде на вхід, а не в цикл.
  await adminLogin();
  const revoked = await page('/admin/status', admin);
  const revokedAgain = await page('/admin/status?recovered=1', admin);
  seen.revoked = [
    revoked.status,
    revoked.html.includes(recovering),
    revoked.html.includes(statusPage),
  ];
  seen.revokedAgain = [revokedAgain.status, revokedAgain.location];
  console.log(`admin page revoked=${JSON.stringify([seen.revoked, seen.revokedAgain])}`);
  assert.deepEqual(seen, {
    adminStatus: [200, true, false],
    adminLink: [200, true],
    userStatus: [307, `${frontend}/exchange/ABC`],
    userLink: [200, false],
    oneStalled: [6],
    stalled: [200, true, true],
    stalledLink: [200, false],
    revoked: [200, true, false],
    revokedAgain: [307, '/login'],
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
