import { isEmail } from 'class-validator';

function required(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function port(value: unknown, key: string): number {
  const text = required(value, key);
  const number = Number(text);
  if (!/^[0-9]+$/.test(text) || number < 1 || number > 65535) {
    throw new Error(`${key} must be an integer from 1 to 65535`);
  }
  return number;
}

function jwtSecret(value: unknown, key: string): string {
  const secret = required(value, key);
  if (secret.trim().length < 32) {
    throw new Error(`${key} must contain at least 32 characters`);
  }
  return secret;
}

function adminEmails(value: unknown, key: string): string[] {
  const entries = required(value, key)
    .split(',')
    .map((email) => email.trim());
  // Регістр порівнюють і JS (`toLowerCase`), і PostgreSQL (`LOWER ... COLLATE "C"`, лише ASCII).
  // Для ASCII-адрес обидва дають однаковий результат; IDN-домен записують у punycode.
  // ASCII перевіряємо до `toLowerCase`: він перетворює, наприклад, знак Кельвіна на `k`.
  const emails = entries.map((email) => email.toLowerCase());
  if (
    entries.some(
      (email) =>
        !/^[ -~]+$/.test(email) || !isEmail(email.toLowerCase(), { allow_utf8_local_part: false }),
    ) ||
    new Set(emails).size !== emails.length
  ) {
    throw new Error(`${key} must contain unique ASCII email addresses`);
  }
  return emails;
}

function adminPassword(value: unknown, key: string): string {
  const password = required(value, key);
  if (password.trim().length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error(`${key} must contain at least 12 characters and at most 72 bytes`);
  }
  return password;
}

const secondsPerUnit = { s: 1, m: 60, h: 3600, d: 86400 };

function tokenTtl(value: unknown, key: string): number {
  const match = /^([1-9][0-9]*)([smhd])$/.exec(required(value, key));
  if (!match) throw new Error(`${key} must be a positive duration with unit s, m, h or d`);
  const seconds = Number(match[1]) * secondsPerUnit[match[2] as keyof typeof secondsPerUnit];
  if (!Number.isSafeInteger(seconds)) throw new Error(`${key} is too large`);
  return seconds;
}

function accessTtl(value: unknown, key: string): number {
  const seconds = tokenTtl(value, key);
  if (seconds > 900) throw new Error(`${key} must not exceed 15 minutes`);
  return seconds;
}

function refreshGrace(value: unknown, key: string): number {
  const text = required(value, key);
  const milliseconds = Number(text);
  if (!/^[0-9]+$/.test(text) || milliseconds > 10000) {
    throw new Error(`${key} must be an integer from 0 to 10000`);
  }
  return milliseconds;
}

function instruments(value: unknown, key: string): string[] {
  const symbols = required(value, key)
    .split(',')
    .map((symbol) => symbol.trim());
  if (
    symbols.some((symbol) => !/^[A-Z][A-Z0-9]{0,15}$/.test(symbol) || symbol === 'USD') ||
    new Set(symbols).size !== symbols.length
  ) {
    throw new Error(`${key} must contain unique instrument symbols with USD as quote asset`);
  }
  return symbols;
}

function boolean(value: unknown, key: string): boolean {
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
  return value === 'true';
}

function milliseconds(value: unknown, key: string): number {
  const text = required(value, key);
  if (
    !/^[0-9]+$/.test(text) ||
    !Number.isSafeInteger(Number(text)) ||
    Number(text) < 1 ||
    Number(text) > 60000
  ) {
    throw new Error(`${key} must be an integer from 1 to 60000`);
  }
  return Number(text);
}

const databaseSchema = {
  DATABASE_HOST: required,
  DATABASE_PORT: port,
  DATABASE_USER: required,
  DATABASE_PASSWORD: required,
  DATABASE_NAME: required,
};

const schema = {
  LEASE_TTL_MS: milliseconds,
  LEASE_RENEW_INTERVAL_MS: milliseconds,
  LEASE_SAFETY_MS: milliseconds,
  ACQUIRE_INTERVAL_MS: milliseconds,
  CHAOS_ENABLED: boolean,
  CHAOS_STALL_BEFORE_COMMIT_MS: milliseconds,
  ENGINE_WORKER_ENABLED: boolean,
  RESERVATIONS_ENABLED: boolean,
  COMMAND_POLL_INTERVAL_MS: milliseconds,
  ORDER_SYNC_WAIT_MS: milliseconds,
  SEQ_GAP_ALERT_MS: milliseconds,
  PORT: port,
  ...databaseSchema,
  REDIS_HOST: required,
  REDIS_PORT: port,
  JWT_ACCESS_SECRET: jwtSecret,
  JWT_REFRESH_SECRET: jwtSecret,
  JWT_ACCESS_TTL: accessTtl,
  JWT_REFRESH_TTL: tokenTtl,
  REFRESH_REUSE_GRACE_MS: refreshGrace,
  ADMIN_EMAILS: adminEmails,
  ADMIN_PASSWORD: adminPassword,
  INSTANCE_ID: required,
  INSTRUMENTS: instruments,
};

export type EngineEnv = { [K in keyof typeof schema]: ReturnType<(typeof schema)[K]> };
export type DatabaseEnv = Pick<EngineEnv, keyof typeof databaseSchema>;

export function validateDatabaseEnv(input: Record<string, unknown>): DatabaseEnv {
  return Object.fromEntries(
    Object.entries(databaseSchema).map(([key, read]) => [key, read(input[key], key)]),
  ) as DatabaseEnv;
}

export function validateEnv(input: Record<string, unknown>): EngineEnv {
  const parsed = Object.fromEntries(
    Object.entries(schema).map(([key, read]) => [key, read(input[key], key)]),
  ) as EngineEnv;
  if (parsed.JWT_ACCESS_SECRET === parsed.JWT_REFRESH_SECRET) {
    throw new Error('JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET');
  }
  if (parsed.LEASE_RENEW_INTERVAL_MS * 3 > parsed.LEASE_TTL_MS) {
    throw new Error('LEASE_RENEW_INTERVAL_MS * 3 must not exceed LEASE_TTL_MS');
  }
  if (parsed.LEASE_SAFETY_MS >= parsed.LEASE_RENEW_INTERVAL_MS) {
    throw new Error('LEASE_SAFETY_MS must be less than LEASE_RENEW_INTERVAL_MS');
  }
  return parsed;
}
