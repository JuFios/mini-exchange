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

function instruments(value: unknown, key: string): string[] {
  const symbols = required(value, key).split(',').map((symbol) => symbol.trim());
  if (symbols.some((symbol) => !/^[A-Z][A-Z0-9]{0,15}$/.test(symbol) || symbol === 'USD')
      || new Set(symbols).size !== symbols.length) {
    throw new Error(`${key} must contain unique instrument symbols with USD as quote asset`);
  }
  return symbols;
}

const databaseSchema = {
  DATABASE_HOST: required,
  DATABASE_PORT: port,
  DATABASE_USER: required,
  DATABASE_PASSWORD: required,
  DATABASE_NAME: required,
};

const schema = {
  PORT: port,
  ...databaseSchema,
  REDIS_HOST: required,
  REDIS_PORT: port,
  JWT_ACCESS_SECRET: jwtSecret,
  JWT_REFRESH_SECRET: jwtSecret,
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
  return parsed;
}
