import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { validateEnv } from '../../src/config/env.validation';

const example = parseEnv(readFileSync(join(__dirname, '../../.env.example'), 'utf8'));
const remote = {
  ...example,
  DEPLOYMENT_MODE: 'remote',
  JWT_ACCESS_SECRET: 'remote-access-secret-value-000001',
  RESERVATION_API_TOKEN: 'remote-reservation-token-value-00001',
  RECONCILIATION_TOKEN: 'remote-reconciliation-token-000001',
  OUTBOX_READ_TOKEN: 'remote-outbox-token-value-000000001',
  REDIS_USERNAME: 'settlement',
  REDIS_PASSWORD: 'remote-redis-password-only',
  LEDGER_DATABASE_PASSWORD: 'remote-ledger-password-only',
  DEMO_INITIAL_BALANCES: 'USD:0,ABC:0,XYZ:0',
};

it('rejects demo secrets in remote mode and preserves the configured demo balances', () => {
  expect(() => validateEnv(remote)).not.toThrow();
  expect(
    validateEnv({ ...remote, DEMO_INITIAL_BALANCES: example.DEMO_INITIAL_BALANCES })
      .DEMO_INITIAL_BALANCES.USD,
  ).toBeGreaterThan(0n);
  for (const key of [
    'JWT_ACCESS_SECRET',
    'RESERVATION_API_TOKEN',
    'RECONCILIATION_TOKEN',
    'OUTBOX_READ_TOKEN',
    'REDIS_PASSWORD',
    'LEDGER_DATABASE_PASSWORD',
  ] as const) {
    expect(() => validateEnv({ ...remote, [key]: example[key] })).toThrow(key);
  }
});

it.each(['default', '', undefined])('rejects remote Redis username %j', (username) => {
  expect(() => validateEnv({ ...remote, REDIS_USERNAME: username })).toThrow('REDIS_USERNAME');
});

it('validates all and only the keys from the env example', () => {
  const parsed = validateEnv(example);
  expect(Object.keys(parsed).sort()).toEqual(Object.keys(example).sort());
});

it.each(['RESERVATION_API_TOKEN', 'JWT_ACCESS_SECRET'])('rejects a 31-character %s', (key) => {
  expect(() => validateEnv({ ...example, [key]: 'a'.repeat(31) })).toThrow(key);
});

it.each([
  ' ' + 'a'.repeat(32),
  'a'.repeat(32) + ' ',
  'a'.repeat(32) + '\n',
  'а'.repeat(32),
  'a'.repeat(1025),
])('rejects an internal token that cannot be sent as a bounded HTTP header', (value) => {
  expect(() => validateEnv({ ...example, RESERVATION_API_TOKEN: value })).toThrow(
    'RESERVATION_API_TOKEN',
  );
});

it.each([
  ['ENGINE_INTERNAL_URL', 'ftp://engine'],
  ['ENGINE_INTERNAL_URL', 'http://engine/path'],
  ['CONSUMER_NAME', 'bad name'],
  ['CONSUMER_NAME', ''],
  ['CONSUMER_CLAIM_IDLE_MS', '10'],
  ['CONSUMER_MAX_DELIVERIES', '0'],
  ['SETTLEMENT_GRACE_MS', '-1'],
])('rejects an invalid %s', (key, value) => {
  expect(() => validateEnv({ ...example, [key]: value })).toThrow(key);
});

it('rejects a 15-character Redis password', () => {
  expect(() => validateEnv({ ...example, REDIS_PASSWORD: 'a'.repeat(15) })).toThrow(
    'REDIS_PASSWORD',
  );
});

it('rejects reuse of credentials between internal scopes', () => {
  expect(() =>
    validateEnv({ ...example, OUTBOX_READ_TOKEN: example.RECONCILIATION_TOKEN }),
  ).toThrow('must differ');
});
