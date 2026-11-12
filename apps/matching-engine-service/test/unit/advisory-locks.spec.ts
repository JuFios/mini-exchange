import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { advisoryLocks } from '../../src/database/advisory-lock';

const registered = Object.values(advisoryLocks).map(({ key }) => key.join(','));

it('gives every advisory lock of the application its own key pair', () => {
  expect(new Set(registered).size).toBe(registered.length);
});

it('takes in the database bootstrap only a registered key pair', () => {
  const script = readFileSync(
    join(__dirname, '../../../../docker/postgres/init/01-init.sh'),
    'utf8',
  );
  const used = [...script.matchAll(/pg_advisory(?:_xact)?_(?:un)?lock\((\d+),\s*(\d+)\)/g)].map(
    ([, group, number]) => `${group},${number}`,
  );
  expect(used.length).toBeGreaterThan(0);
  for (const key of used) expect(registered).toContain(key);
});
