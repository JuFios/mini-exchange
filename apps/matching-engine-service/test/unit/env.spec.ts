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
  expect(parsed.ADMIN_EMAILS).toEqual(['admin@demo.local']);
  expect(parsed.JWT_ACCESS_TTL).toBe(900);
  expect(parsed.REFRESH_REUSE_GRACE_MS).toBe(10000);
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

it('requires ADMIN_PASSWORD to have at least twelve characters and fit in bcrypt', () => {
  expect(() => validateEnv({ ...example, ADMIN_PASSWORD: 'a'.repeat(11) })).toThrow('ADMIN_PASSWORD');
  expect(() => validateEnv({ ...example, ADMIN_PASSWORD: undefined })).toThrow('ADMIN_PASSWORD');
  expect(() => validateEnv({ ...example, ADMIN_PASSWORD: 'а'.repeat(37) })).toThrow('ADMIN_PASSWORD');
});

it.each([
  ['ADMIN_EMAILS', 'admin@example.test,ADMIN@example.test'],
  ['ADMIN_EMAILS', 'invalid'],
  ['ADMIN_EMAILS', 'admin@пошта.укр'],
  ['ADMIN_EMAILS', 'admin@\u212Aelvin.example'],
  ['JWT_ACCESS_TTL', '16m'],
  ['JWT_REFRESH_TTL', '0s'],
  ['REFRESH_REUSE_GRACE_MS', '10001'],
])('rejects invalid %s configuration', (key, value) => {
  expect(() => validateEnv({ ...example, [key]: value })).toThrow(key);
});
