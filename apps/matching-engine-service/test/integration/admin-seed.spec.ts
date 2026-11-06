import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AdminSeedService } from '../../src/auth/admin-seed.service';
import { User } from '../../src/auth/entities/user.entity';
import { migrate } from '../../src/database/migrate';
import { testDatabase } from '../test-database';

const emails = ['first-admin@example.test', 'second-admin@example.test'];
const password = 'seed-password-0123456789';

let database: ReturnType<typeof testDatabase>;
let source: ReturnType<typeof database.source>;

function seeder() {
  return new AdminSeedService(
    source.getRepository(User),
    new ConfigService({ ADMIN_EMAILS: emails, ADMIN_PASSWORD: password }),
  );
}

async function accounts() {
  return source.query('SELECT email, admin_seeded, password_hash FROM users ORDER BY email') as Promise<
    { email: string; admin_seeded: boolean; password_hash: string }[]
  >;
}

beforeEach(async () => {
  database = testDatabase();
  source = database.source();
  await database.create();
  await source.initialize();
  await migrate(source, 'run');
});

afterEach(async () => {
  try {
    if (source.isInitialized) await source.destroy();
  } finally {
    await database.destroy();
  }
});

it('lets two replicas seed the same accounts at startup without errors or duplicates', async () => {
  await Promise.all([seeder().onApplicationBootstrap(), seeder().onApplicationBootstrap()]);

  const rows = await accounts();
  expect(rows.map((row) => [row.email, row.admin_seeded])).toEqual(emails.map((email) => [email, true]));
  for (const row of rows) expect(await bcrypt.compare(password, row.password_hash)).toBe(true);
});

it('rolls back the whole seed when a regular account takes an address between the check and the insert', async () => {
  const racer = database.source();
  await racer.initialize();
  const runner = racer.createQueryRunner();
  let seeding: Promise<void> | undefined;
  try {
    // Незавершена реєстрація тримає адресу: перевірка seed її ще не бачить, а вставка чекає.
    await runner.startTransaction();
    await runner.query("INSERT INTO users (email, password_hash) VALUES ($1, 'regular-hash')", [emails[1]]);
    seeding = seeder().onApplicationBootstrap();
    seeding.catch(() => undefined);

    for (let attempt = 0; ; attempt++) {
      const [{ waiting }] = await source.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      ) as { waiting: number }[];
      if (waiting > 0) break;
      if (attempt >= 100) throw new Error('The seed insert never waited for the pending registration');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await runner.commitTransaction();

    await expect(seeding).rejects.toThrow(/ADMIN_EMAILS.*regular account/);
    expect(await accounts()).toEqual([{ email: emails[1], admin_seeded: false, password_hash: 'regular-hash' }]);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
    await racer.destroy();
    await seeding?.catch(() => undefined);
  }
});

it('keeps existing seed passwords and creates only the missing accounts', async () => {
  await seeder().onApplicationBootstrap();
  const [before] = await accounts();
  await source.query('DELETE FROM users WHERE email = $1', [emails[1]]);

  await seeder().onApplicationBootstrap();
  const rows = await accounts();
  expect(rows).toHaveLength(2);
  expect(rows[0].password_hash).toBe(before.password_hash);
});
