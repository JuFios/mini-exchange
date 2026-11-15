import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cleanup, container, docker, engine, request, token, until, waitReady } from './helpers';

// Відповіді, які формує сам nginx на `:3001`, мають ті самі CORS-заголовки, що й відповідь
// engine для того ж origin. Інакше браузерний клієнт бачить мережеву помилку замість статусу.
const allowed = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const origins = [...allowed, 'https://not-allowed.example'];
const replicas = ['matching-engine-1', 'matching-engine-2'];
const internal = 'http://engine-lb:8080';

// Прогін, убитий посеред паузи чи зупинки, не має ламати наступний.
const resume = (id: string) => {
  const state = docker('inspect', '--format', '{{.State.Status}}', id);
  if (state === 'paused') docker('unpause', id);
  if (state === 'exited') docker('start', id);
};

type Seen = {
  status: number;
  origin: string | null;
  engine: string | null;
  vary: string | null;
  type: string | null;
  statusCode: unknown;
};

async function seen(response: Response, origin: string): Promise<Seen> {
  const text = await response.text();
  let statusCode: unknown;
  try {
    statusCode = (JSON.parse(text) as { statusCode?: unknown }).statusCode;
  } catch {
    statusCode = `not json: ${text.slice(0, 80)}`;
  }
  // Відповідь engine для того ж origin; дубль заголовка fetch склеїв би через кому.
  const served = await request('/instruments', 'GET', undefined, undefined, engine, { origin });
  await served.arrayBuffer();
  return {
    status: response.status,
    origin: response.headers.get('access-control-allow-origin'),
    engine: served.headers.get('access-control-allow-origin'),
    vary: response.headers.get('vary'),
    type: response.headers.get('content-type')?.split(';')[0] ?? null,
    statusCode,
  };
}

// `read: false` — nginx відхилив запит раніше, ніж прочитав Origin, тож ACAO немає ні для кого.
const expected = (status: number, origin: string, read = true): Seen => {
  const ok = allowed.includes(origin) ? origin : null;
  return {
    status,
    origin: read ? ok : null,
    engine: ok,
    vary: 'Origin',
    type: 'application/json',
    statusCode: status,
  };
};

async function main() {
  const ids = replicas.map(container);
  for (const id of ids) resume(id);
  for (const service of replicas) await waitReady(service, 120000);
  const accessToken = await token(
    'register',
    `${randomUUID()}@system.test`,
    'system-user-password',
  );
  const results: Record<string, Record<string, Seen>> = {};
  const wants: Record<string, Record<string, Seen>> = {};
  const check = async (
    name: string,
    status: number,
    provoke: (headers: Record<string, string>) => Promise<Response>,
    read = true,
  ) => {
    results[name] = {};
    wants[name] = {};
    for (const origin of origins) {
      results[name][origin] = await seen(await provoke({ origin }), origin);
      wants[name][origin] = expected(status, origin, read);
    }
  };

  // Відповідь engine з помилкою nginx не підміняє: тіло й один ACAO лишаються від engine.
  const missing = await request(`/orders/${randomUUID()}`, 'GET', accessToken, undefined, engine, {
    origin: allowed[0],
  });
  const missingBody = (await missing.json()) as { message?: string };
  assert.deepEqual(
    {
      status: missing.status,
      message: missingBody.message,
      origin: missing.headers.get('access-control-allow-origin'),
    },
    { status: 404, message: 'Заявку не знайдено', origin: allowed[0] },
  );

  await check('internal 404', 404, (headers) =>
    request('/internal/auth/session', 'GET', accessToken, undefined, engine, headers),
  );
  await check('metrics 404', 404, (headers) =>
    request('/metrics', 'GET', undefined, undefined, engine, headers),
  );
  // Тіло понад client_max_body_size (1 МБ).
  const large = JSON.stringify({
    instrument: 'XYZ',
    side: 'buy',
    price: '1',
    quantity: '1',
    pad: 'x'.repeat(1_100_000),
  });
  await check('body 413', 413, (headers) =>
    fetch(`${engine}/orders`, {
      method: 'POST',
      headers: {
        ...headers,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: large,
      signal: AbortSignal.timeout(15000),
    }),
  );
  // Заголовок понад буфер large_client_header_buffers (8 КБ). nginx перестає читати заголовки на
  // задовгому рядку: Origin перед ним відомий, після нього — ні. Назви задають порядок і для
  // fetch, що впорядковує заголовки за абеткою.
  await check('header after origin 400', 400, (headers) =>
    request('/instruments', 'GET', undefined, undefined, engine, {
      ...headers,
      'x-padding': 'x'.repeat(9000),
    }),
  );
  await check(
    'header before origin 400',
    400,
    (headers) =>
      request('/instruments', 'GET', undefined, undefined, engine, {
        'a-padding': 'x'.repeat(9000),
        ...headers,
      }),
    false,
  );
  // Рядок запиту понад той самий буфер: до заголовків nginx не доходить.
  await check(
    'uri 414',
    414,
    (headers) =>
      request(`/orders?pad=${'x'.repeat(9000)}`, 'GET', accessToken, undefined, engine, headers),
    false,
  );

  let failure: unknown;
  try {
    // Зависла репліка: nginx чекає proxy_read_timeout на кожній і відповідає 504.
    for (const id of ids) docker('pause', id);
    // Проби 504 читають книгу: її ліміт з'єднань не рахує, тож перевірки ролі нижче не можуть
    // забрати їм місце, хоч би в якому порядку запити дійшли до nginx.
    const probes = Promise.all(
      origins.map(
        async (origin) =>
          [
            origin,
            await request(
              '/instruments/ABC/book',
              'GET',
              undefined,
              undefined,
              engine,
              { origin },
              60000,
            ),
          ] as const,
      ),
    );
    // Завислі репліки тримають з'єднання, тож запити понад ліміт з'єднань на `:8080` отримують
    // 429 від nginx: у тому самому JSON із `Retry-After`, що й на `location /`, а не HTML.
    const roleChecks = Promise.all(
      Array.from({ length: 70 }, async () => {
        try {
          const response = await request(
            '/auth/admin',
            'GET',
            accessToken,
            undefined,
            internal,
            {},
            10000,
          );
          const text = await response.text();
          return {
            status: response.status,
            type: response.headers.get('content-type')?.split(';')[0] ?? null,
            retry: response.headers.get('retry-after'),
            text,
          };
        } catch (error) {
          return { status: 0, type: null, retry: null, text: (error as Error).name };
        }
      }),
    );
    const paused = await probes;
    const limited = (await roleChecks).filter(({ status }) => status === 429);
    for (const id of ids) docker('unpause', id);
    const shapes = new Set(
      limited.map(({ type, retry, text }) => JSON.stringify({ type, retry, text })),
    );
    console.log(
      `engine-lb internal limit refused=${limited.length} shapes=${[...shapes].join(' ')}`,
    );
    assert(limited.length > 0, 'The connection limit on the internal listener refused nothing');
    assert.deepEqual(
      [...shapes],
      [
        JSON.stringify({
          type: 'application/json',
          retry: '1',
          text: '{"statusCode":429,"message":"Забагато запитів"}',
        }),
      ],
    );
    // Engine знову відповідає, тож порівняння з його ACAO чесне.
    await until(
      async () => (await request('/health')).status,
      (status) => status === 200,
      30000,
    );
    results['timeout 504'] = {};
    wants['timeout 504'] = {};
    for (const [origin, response] of paused) {
      results['timeout 504'][origin] = await seen(response, origin);
      wants['timeout 504'][origin] = expected(504, origin);
    }

    // Зупинені репліки зникають з DNS Compose: nginx лишається без адрес і відповідає 502.
    for (const id of ids) docker('stop', '--time', '5', id);
    const down: Record<string, Response> = {};
    for (const origin of origins)
      down[origin] = await until(
        async () => {
          const response = await request(
            '/instruments',
            'GET',
            undefined,
            undefined,
            engine,
            { origin },
            10000,
          );
          if (response.status !== 502) await response.arrayBuffer();
          return response;
        },
        (response) => response.status === 502,
        30000,
      );
    for (const id of ids) docker('start', id);
    for (const service of replicas) await waitReady(service, 120000);
    await until(
      async () => (await request('/health')).status,
      (status) => status === 200,
      30000,
    );
    results['down 502'] = {};
    wants['down 502'] = {};
    for (const origin of origins) {
      results['down 502'][origin] = await seen(down[origin], origin);
      wants['down 502'][origin] = expected(502, origin);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanup(failure, ...ids.map((id) => () => resume(id)));
  }
  console.log(`engine-lb errors ${JSON.stringify(results)}`);
  assert.deepEqual(results, wants);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
