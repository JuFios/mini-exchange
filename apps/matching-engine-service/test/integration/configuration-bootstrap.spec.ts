import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { testDatabase } from '../test-database';
import { migrate } from '../../src/database/migrate';
const database = testDatabase();
const example = parseEnv(readFileSync(join(__dirname, '../../.env.example'), 'utf8'));
beforeAll(async () => {
  await database.create();
  const source = database.source();
  await source.initialize();
  try {
    await migrate(source, 'run');
  } finally {
    await source.destroy();
  }
});
afterAll(() => database.destroy());
it.each(['true', 'false'])(
  'registers the chaos route from a file-only CHAOS_ENABLED=%s',
  async (flag) => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-env-'));
    const values = {
      ...example,
      ...database.env,
      REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
      REDIS_PORT: process.env.REDIS_PORT ?? '6379',
      REDIS_PASSWORD: process.env.REDIS_PASSWORD ?? 'exchange-redis-local-only',
      CHAOS_ENABLED: flag,
      ENGINE_WORKER_ENABLED: 'false',
    };
    writeFileSync(
      join(directory, '.env'),
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
    );
    const env = { ...process.env };
    for (const key of Object.keys(values)) delete env[key];
    env.TS_NODE_PROJECT = join(__dirname, '../../tsconfig.json');
    const child = spawn(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register/transpile-only'),
        join(__dirname, '../helpers/configuration-process.ts'),
      ],
      { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let diagnostics = '';
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    try {
      const ready = await new Promise<{ url: string; chaos: boolean }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Configuration child timeout: ${diagnostics}`)),
          10000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Configuration child exited: ${diagnostics}`));
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const match = /CONFIG_READY (.+)\n/.exec(output);
          if (match) {
            clearTimeout(timer);
            resolve(JSON.parse(match[1]));
          }
        });
      });
      expect(ready.chaos).toBe(flag === 'true');
      const login = await fetch(`${ready.url}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: example.ADMIN_EMAILS, password: example.ADMIN_PASSWORD }),
        signal: AbortSignal.timeout(3000),
      });
      expect(login.status).toBe(201);
      const token = (await login.json()).accessToken;
      const response = await fetch(`${ready.url}/admin/chaos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ point: 'after_writes_before_commit' }),
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(flag === 'true' ? 201 : 404);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
        try {
          await ended;
        } finally {
          clearTimeout(kill);
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15000,
);
