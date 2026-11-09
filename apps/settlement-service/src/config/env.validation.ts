import { ASSET_SCALES, Asset, parseAmount } from '../ledger/amount';

function required(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function integer(min: number, max: number) {
  return (value: unknown, key: string) => {
    const text = required(value, key);
    const number = Number(text);
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return number;
  };
}

function secret(value: unknown, key: string): string {
  const text = required(value, key);
  if (text.trim().length < 32) throw new Error(`${key} must contain at least 32 characters`);
  return text;
}

function demoBalances(value: unknown, key: string): Record<Asset, bigint> {
  const balances: Partial<Record<Asset, bigint>> = {};
  try {
    for (const entry of required(value, key).split(',')) {
      const [asset, amount, extra] = entry.split(':');
      if (
        !Object.prototype.hasOwnProperty.call(ASSET_SCALES, asset) ||
        amount === undefined ||
        extra !== undefined
      )
        throw new Error();
      const code = asset as Asset;
      if (balances[code] !== undefined) throw new Error();
      balances[code] = parseAmount(amount, ASSET_SCALES[code]);
    }
    if (Object.keys(balances).length !== Object.keys(ASSET_SCALES).length) throw new Error();
  } catch {
    throw new Error(`${key} must contain one nonnegative amount for each supported asset`);
  }
  return balances as Record<Asset, bigint>;
}

const port = integer(1, 65535);
const databaseSchema = {
  LEDGER_DATABASE_HOST: required,
  LEDGER_DATABASE_PORT: port,
  LEDGER_DATABASE_USER: required,
  LEDGER_DATABASE_PASSWORD: required,
  LEDGER_DATABASE_NAME: required,
};

function internalToken(value: unknown, key: string): string {
  const text = required(value, key);
  if (text.length < 32 || text.length > 1024 || /[^\x21-\x7e]/.test(text))
    throw new Error(`${key} must contain 32 to 1024 visible ASCII characters`);
  return text;
}

function origin(value: unknown, key: string): string {
  const text = required(value, key);
  try {
    const url = new URL(text);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${key} must be an HTTP or HTTPS origin`);
  }
}

function consumerName(value: unknown, key: string): string {
  const text = required(value, key);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(text))
    throw new Error(`${key} must contain 1 to 64 letters, digits, dots, dashes or underscores`);
  return text;
}

const schema = {
  PORT: port,
  ...databaseSchema,
  REDIS_HOST: required,
  REDIS_PORT: port,
  STREAM_MAXLEN: integer(1, Number.MAX_SAFE_INTEGER),
  CONSUMER_NAME: consumerName,
  CONSUMER_CLAIM_IDLE_MS: integer(1000, 3_600_000),
  CONSUMER_MAX_DELIVERIES: integer(1, 1000),
  SETTLEMENT_GRACE_MS: integer(0, 86_400_000),
  ENGINE_INTERNAL_URL: origin,
  JWT_ACCESS_SECRET: secret,
  INTERNAL_API_TOKEN: internalToken,
  DEMO_INITIAL_BALANCES: demoBalances,
};

export type SettlementEnv = { [K in keyof typeof schema]: ReturnType<(typeof schema)[K]> };
export type LedgerDatabaseEnv = Pick<SettlementEnv, keyof typeof databaseSchema>;

export function validateDatabaseEnv(input: Record<string, unknown>): LedgerDatabaseEnv {
  return Object.fromEntries(
    Object.entries(databaseSchema).map(([key, read]) => [key, read(input[key], key)]),
  ) as LedgerDatabaseEnv;
}

export function validateEnv(input: Record<string, unknown>): SettlementEnv {
  return Object.fromEntries(
    Object.entries(schema).map(([key, read]) => [key, read(input[key], key)]),
  ) as SettlementEnv;
}
