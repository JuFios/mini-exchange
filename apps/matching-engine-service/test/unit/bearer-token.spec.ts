import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEARER_HEADER, bearerToken } from '../../src/auth/bearer-token';

const token = 'aGVhZGVy.cGF5bG9hZA.' + 'S'.repeat(43);

it('matches the expression that keys the ingress read limit', () => {
  const config = readFileSync(join(__dirname, '../../../../deploy/nginx/engine-lb.conf'), 'utf8');
  // Блок до рядка з одним `}`: у самому виразі є `{43}`.
  const block =
    /map "\$orders_read:\$http_authorization" \$orders_token_key \{\n([\s\S]*?)\n\}\n/.exec(config);
  expect(block).not.toBeNull();
  // Рівно один вираз і порожнє значення за замовчуванням: другий вираз ключував би інші форми.
  const entries = block![1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toBe('default "";');
  const entry = /^"~\*\^1:([^"]+)" \$orders_token;$/.exec(entries[0]);
  expect(entry).not.toBeNull();
  // `g` чи `y` зберігали б `lastIndex` між викликами `exec`.
  expect(BEARER_HEADER.flags).toBe('i');
  expect('^' + entry![1].replace('(?<orders_token>', '(?<signature>')).toBe(BEARER_HEADER.source);
});

it.each([
  [`Bearer ${token}`, token],
  [`bearer\t${token}`, token],
  // fetch і llhttp обрізають пробіли на початку, тож цю форму перевіряє лише unit-тест.
  [` Bearer  ${token} trailing`, token],
  [`Bearer\u00a0${token}`, undefined],
  [`\u00a0Bearer ${token}`, undefined],
  // Підпис HS256 має рівно 43 символи base64url.
  [`Bearer ${token}S`, undefined],
  [`Basic ${token}`, undefined],
  [undefined, undefined],
])('reads %j as %j', (header, expected) => {
  expect(bearerToken(header)).toBe(expected);
});
