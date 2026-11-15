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
  expect(limited.map((server) => /listen (\d+);/.exec(server)?.[1])).toEqual(['3001', '8080']);
  for (const server of limited) {
    expect(server).toMatch(/\n {2}error_page 429 @too_many_requests;\n/);
    expect(server).not.toMatch(/\n {4,}error_page /);
    expect(server).toMatch(/\n {2}location @too_many_requests \{\n/);
  }
});
