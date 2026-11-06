import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { validateEnv } from '../../src/config/env.validation';

const example = parseEnv(readFileSync(join(__dirname, '../../.env.example'), 'utf8'));

it('accepts the example and declares exactly the same keys', () => {
  const parsed = validateEnv(example);
  expect(Object.keys(parsed).sort()).toEqual(Object.keys(example).sort());
  expect(parsed.INSTRUMENTS).toEqual(['ABC', 'XYZ']);
  expect(parsed.PORT).toBe(3001);
});

it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])('requires a distinct %s of at least 32 characters', (key) => {
  expect(() => validateEnv({ ...example, [key]: 'a'.repeat(31) })).toThrow(key);
  expect(() => validateEnv({ ...example, [key]: undefined })).toThrow(key);
});

it('rejects equal JWT secrets and names both settings', () => {
  expect(() => validateEnv({ ...example, JWT_REFRESH_SECRET: example.JWT_ACCESS_SECRET }))
    .toThrow(/JWT_REFRESH_SECRET.*JWT_ACCESS_SECRET/);
});

it.each(['ABC,,XYZ', 'ABC,ABC', 'abc', 'USD'])('rejects invalid instruments %s', (symbols) => {
  expect(() => validateEnv({ ...example, INSTRUMENTS: symbols })).toThrow('INSTRUMENTS');
});
