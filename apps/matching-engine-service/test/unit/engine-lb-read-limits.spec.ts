import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  ];
  expect(limits(3001)).toEqual(expected);
  expect(limits(8080)).toEqual(expected);
  // Лічильник стелі окремий для кожного listener і лише для читань заявок.
  expect(config).toContain('map "$orders_read:$server_port" $orders_listener_key {');
  expect(config).toMatch(/limit_req_zone \$orders_listener_key zone=orders_reads_total:\S+ rate=/);
});
