import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps the engine ingress credential out of requests to the frontend', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  const frontend = config.split(/\nserver \{\n/).find((server) => server.includes('listen 3000;'));
  expect(frontend).toBeDefined();
  expect(frontend).not.toContain('X-Exchange-Ingress');
  const ingress = readFileSync(
    join(__dirname, '../../../../deploy/nginx/ingress-token.conf.template'),
    'utf8',
  );
  expect(ingress).toContain('map $http_x_frontend_proxy $exchange_frontend_trusted');
  expect(ingress).toContain('$server_port:$exchange_frontend_trusted:$http_x_forwarded_for');
});

// System-сценарій потоку з багатьох адрес може підробити адресу лише на `:8080`. Публічний
// listener має мати ті самі ліміти читань у тому самому порядку.
it('applies the address, token and listener read limits on both engine listeners', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  const limits = (port: number) => {
    const server = config.split(/\nserver \{\n/).find((block) => block.includes(`listen ${port};`));
    const root = server?.split('\n  location / {\n')[1]?.split('\n  }\n')[0] ?? '';
    return root
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('limit_req zone='));
  };
  const expected = [
    'limit_req zone=orders_reads_by_client burst=500 nodelay;',
    'limit_req zone=orders_reads burst=100 nodelay;',
    'limit_req zone=orders_reads_total burst=200 nodelay;',
    'limit_req zone=orders_writes_by_client burst=1000 delay=200;',
    'limit_req zone=orders_writes burst=100 nodelay;',
  ];
  expect(limits(3001)).toEqual(expected);
  expect(limits(8080)).toEqual(expected);
  // Лічильник стелі окремий для кожного listener і лише для читань заявок.
  expect(config).toContain('map "$orders_read:$server_port" $orders_listener_key {');
  expect(config).toMatch(/limit_req_zone \$orders_listener_key zone=orders_reads_total:\S+ rate=/);
});

// Подання й скасування ключуються так само, як читання, але у своїх зонах і без стелі listener.
it('keys order writes by token and client address in separate zones', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  const map = /map "\$request_method:\$uri" \$orders_write \{\n([\s\S]*?)\n\}\n/.exec(config);
  expect(map?.[1].split('\n').map((line) => line.trim())).toEqual([
    '~*^(POST|DELETE):/orders(?:/|$) 1;',
    'default "";',
  ]);
  expect(config).toMatch(
    /limit_req_zone \$orders_write_token_key zone=orders_writes:\S+ rate=20r\/s;/,
  );
  expect(config).toMatch(
    /limit_req_zone \$orders_write_client_key zone=orders_writes_by_client:\S+ rate=100r\/s;/,
  );
  const client =
    /map "\$orders_write:\$server_port:\$exchange_client_address" \$orders_write_client_key \{\n([\s\S]*?)\n\}\n/.exec(
      config,
    );
  expect(client?.[1].split('\n').map((line) => line.trim())).toEqual([
    '"~^1:8080:(?<orders_write_forwarded>.+)$" $orders_write_forwarded;',
    '"~^1:" $remote_addr;',
    'default "";',
  ]);
});

// Ліміт без обробника 429 віддає HTML без `Retry-After`. Обробник на рівні server діє на всі
// location, зокрема на додані пізніше; власний error_page у location його б вимкнув.
it('answers every nginx rate refusal with the JSON 429 handler', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  const servers = config.split(/\nserver \{\n/).slice(1);
  // Будь-який відступ: ліміт на рівні server чи у вкладеному location теж рахується.
  const limited = servers.filter((server) => /^\s+limit_(?:conn|req)\s/m.test(server));
  expect(limited.map((server) => /listen (\d+);/.exec(server)?.[1])).toEqual([
    '3001',
    '8080',
    '3000',
  ]);
  for (const server of limited) {
    expect(server).toMatch(/\n {2}error_page 429 @too_many_requests;\n/);
    expect(server).not.toMatch(/\n {4,}error_page /);
    expect(server).toMatch(/\n {2}location @too_many_requests \{\n/);
  }
});

// Один спільний лічильник з'єднань дозволяв одному анонімному клієнту зайняти всі слоти
// HTTP-маршрутів поза заявками на обох listener. Межа має бути на клієнта і нижчою за стелю;
// стеля — стара спільна межа обох listener, щоб навантаження на engine не зросло.
it('limits non-order engine connections per client below the shared ceiling', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  expect(config).toContain(
    'map "$engine_rest_scope:$server_port:$exchange_client_address" $engine_rest_client {',
  );
  expect(config).toContain('limit_conn_zone $engine_rest_client zone=engine_rest_by_client:10m;');
  expect(config).toContain('limit_conn_zone $engine_rest_scope zone=engine_rest_total:64k;');
  // Спільний для всіх клієнтів ключ має лише стеля.
  const zones = [...config.matchAll(/^limit_conn_zone (\S+) zone=(\w+):/gm)].map(
    ([, key, zone]) => `${zone}=${key}`,
  );
  expect(zones).toEqual([
    'engine_rest_by_client=$engine_rest_client',
    'engine_rest_total=$engine_rest_scope',
    'engine_ws_by_ip=$binary_remote_addr',
    'frontend_active_by_client=$binary_remote_addr',
    'frontend_active_total=$server_name',
  ]);
  const limits = [...config.matchAll(/^ +limit_conn (engine_rest\w*) (\d+);$/gm)].map(
    ([, zone, value]) => `${zone} ${value}`,
  );
  // `location /` на `:3001`, `/auth/admin` і `location /` на `:8080`.
  expect(limits).toEqual(
    Array.from({ length: 3 }, () => ['engine_rest_by_client 16', 'engine_rest_total 64']).flat(),
  );
});

// Next BFF обслуговує всіх користувачів одним процесом: ingress обмежує кожну адресу клієнта.
// Відсутній статичний файл Next рендерить сторінку 404, тож префікс статики теж має квоту.
it('limits every frontend route per client address, static assets in their own zone', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  const map = (name: string) =>
    new RegExp(`map \\$uri \\$${name} \\{\\n([\\s\\S]*?)\\n\\}\\n`)
      .exec(config)?.[1]
      .split('\n')
      .map((line) => line.trim());
  expect(map('frontend_client_key')).toEqual([
    '~^/_next/static/ "";',
    'default $binary_remote_addr;',
  ]);
  expect(map('frontend_static_key')).toEqual([
    '~^/_next/static/ $binary_remote_addr;',
    'default "";',
  ]);
  const frontend = config.split(/\nserver \{\n/).find((server) => server.includes('listen 3000;'));
  // На рівні server, щоб ліміт успадкували всі location, зокрема довга звірка.
  expect(frontend).toMatch(/\n {2}limit_req zone=frontend_by_client burst=\d+ nodelay;\n/);
  expect(frontend).toMatch(/\n {2}limit_req zone=frontend_static_by_client burst=\d+ nodelay;\n/);
  expect(frontend).not.toMatch(/\n {4,}limit_req /);
});

// Settlement не обмежує `GET /wallets`, тож nginx тримає квоту на токен і на адресу клієнта.
it('limits wallet reads by client address and token', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  const wallets = /\n {2}location = \/settlement\/wallets \{\n([\s\S]*?)\n {2}\}\n/.exec(config);
  expect(
    wallets?.[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('limit_req zone=')),
  ).toEqual([
    'limit_req zone=wallets_reads_by_client burst=500 nodelay;',
    'limit_req zone=wallets_reads burst=100 nodelay;',
  ]);
  expect(config).toMatch(/limit_req_zone \$wallets_token_key zone=wallets_reads:\S+ rate=20r\/s;/);
  expect(config).toMatch(
    /limit_req_zone \$exchange_client_address zone=wallets_reads_by_client:\S+ rate=100r\/s;/,
  );
});
