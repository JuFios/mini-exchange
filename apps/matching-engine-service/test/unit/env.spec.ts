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

it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])(
  'requires a distinct %s of at least 32 characters',
  (key) => {
    expect(() => validateEnv({ ...example, [key]: 'a'.repeat(31) })).toThrow(key);
    expect(() => validateEnv({ ...example, [key]: undefined })).toThrow(key);
  },
);

it('rejects equal JWT secrets and names both settings', () => {
  expect(() => validateEnv({ ...example, JWT_REFRESH_SECRET: example.JWT_ACCESS_SECRET })).toThrow(
    /JWT_REFRESH_SECRET.*JWT_ACCESS_SECRET/,
  );
});

it.each(['ABC,,XYZ', 'ABC,ABC', 'abc', 'USD'])('rejects invalid instruments %s', (symbols) => {
  expect(() => validateEnv({ ...example, INSTRUMENTS: symbols })).toThrow('INSTRUMENTS');
});

it('requires ADMIN_PASSWORD to have at least twelve characters and fit in bcrypt', () => {
  expect(() => validateEnv({ ...example, ADMIN_PASSWORD: 'a'.repeat(11) })).toThrow(
    'ADMIN_PASSWORD',
  );
  expect(() => validateEnv({ ...example, ADMIN_PASSWORD: undefined })).toThrow('ADMIN_PASSWORD');
  expect(() => validateEnv({ ...example, ADMIN_PASSWORD: 'а'.repeat(37) })).toThrow(
    'ADMIN_PASSWORD',
  );
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

it.each(['ENGINE_WORKER_ENABLED', 'RESERVATIONS_ENABLED'])('requires a boolean %s', (key) => {
  expect(() => validateEnv({ ...example, [key]: 'yes' })).toThrow(key);
});

it.each([
  'COMMAND_POLL_INTERVAL_MS',
  'OUTBOX_POLL_INTERVAL_MS',
  'ORDER_SYNC_WAIT_MS',
  'SEQ_GAP_ALERT_MS',
])('bounds %s', (key) => {
  for (const value of ['0', '-1', '60001', '1.5'])
    expect(() => validateEnv({ ...example, [key]: value })).toThrow(key);
});

it('uses outbox defaults for existing environments and rejects invalid stream lengths', () => {
  const config = validateEnv({
    ...example,
    OUTBOX_POLL_INTERVAL_MS: undefined,
    STREAM_MAXLEN: undefined,
  });
  expect(config.OUTBOX_POLL_INTERVAL_MS).toBe(100);
  expect(config.STREAM_MAXLEN).toBe(1000000);
  for (const value of ['0', '-1', '1.5', '9007199254740992']) {
    expect(() => validateEnv({ ...example, STREAM_MAXLEN: value })).toThrow('STREAM_MAXLEN');
  }
});

it('rejects renew intervals and safety windows that exceed the lease budget', () => {
  expect(() =>
    validateEnv({ ...example, LEASE_RENEW_INTERVAL_MS: '2000', LEASE_TTL_MS: '5000' }),
  ).toThrow('LEASE_RENEW_INTERVAL_MS');
  expect(() =>
    validateEnv({ ...example, LEASE_SAFETY_MS: '1600', LEASE_RENEW_INTERVAL_MS: '1500' }),
  ).toThrow('LEASE_SAFETY_MS');
});

it('requires an internal token of at least 32 characters', () => {
  expect(() => validateEnv({ ...example, INTERNAL_API_TOKEN: 'a'.repeat(31) })).toThrow(
    'INTERNAL_API_TOKEN',
  );
});

it.each([
  'ftp://settlement.test',
  'https://name:secret@settlement.test',
  'https://settlement.test/path',
])('rejects a settlement endpoint that is not a plain HTTP origin', (SETTLEMENT_URL) =>
  expect(() => validateEnv({ ...example, SETTLEMENT_URL })).toThrow('SETTLEMENT_URL'),
);

it.each([
  ' ' + 'a'.repeat(32),
  'a'.repeat(32) + ' ',
  'a'.repeat(32) + '\n',
  'а'.repeat(32),
  'a'.repeat(1025),
])('rejects an internal token that cannot be sent as a bounded HTTP header', (value) => {
  expect(() =>
    validateEnv({ ...example, RESERVATIONS_ENABLED: 'true', INTERNAL_API_TOKEN: value }),
  ).toThrow('INTERNAL_API_TOKEN');
});

it('accepts the previous environment when reservation support is disabled', () => {
  const config = { ...example, RESERVATIONS_ENABLED: 'false' };
  for (const key of [
    'SETTLEMENT_URL',
    'INTERNAL_API_TOKEN',
    'RESERVATION_TIMEOUT_MS',
    'RESERVATION_SWEEP_AFTER_MS',
    'RESERVATION_SWEEP_INTERVAL_MS',
  ])
    delete (config as Record<string, unknown>)[key];
  expect(validateEnv(config).RESERVATIONS_ENABLED).toBe(false);
});

it.each([
  'SETTLEMENT_URL',
  'INTERNAL_API_TOKEN',
  'RESERVATION_TIMEOUT_MS',
  'RESERVATION_SWEEP_AFTER_MS',
  'RESERVATION_SWEEP_INTERVAL_MS',
])('still requires %s when reservations are enabled', (key) => {
  expect(() => validateEnv({ ...example, RESERVATIONS_ENABLED: 'true', [key]: undefined })).toThrow(
    key,
  );
});
