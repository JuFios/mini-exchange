import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { validateEnv } from '../../src/config/env.validation';

const example = parseEnv(readFileSync(join(__dirname, '../../.env.example'), 'utf8'));

it('validates all and only the keys from the env example', () => {
  const parsed = validateEnv(example);
  expect(Object.keys(parsed).sort()).toEqual(Object.keys(example).sort());
});

it.each(['INTERNAL_API_TOKEN', 'JWT_ACCESS_SECRET'])('rejects a 31-character %s', (key) => {
  expect(() => validateEnv({ ...example, [key]: 'a'.repeat(31) })).toThrow(key);
});

it.each([
  ' ' + 'a'.repeat(32),
  'a'.repeat(32) + ' ',
  'a'.repeat(32) + '\n',
  'а'.repeat(32),
  'a'.repeat(1025),
])('rejects an internal token that cannot be sent as a bounded HTTP header', (value) => {
  expect(() => validateEnv({ ...example, INTERNAL_API_TOKEN: value })).toThrow(
    'INTERNAL_API_TOKEN',
  );
});
