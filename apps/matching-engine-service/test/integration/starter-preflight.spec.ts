import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/database/migrate';
import { testDatabase } from '../test-database';

it('rejects the real starter camelCase schema before creating migration history or changing rows', async () => {
  const database = testDatabase();
  await database.create();
  const source = database.source();
  await source.initialize();
  try {
    // DDL відповідає entities з starter-baseline, включно з camelCase колонками.
    await source.query(`CREATE TABLE users (id uuid PRIMARY KEY, email varchar NOT NULL UNIQUE,
      "passwordHash" varchar NOT NULL, "refreshTokenHash" varchar);
      CREATE TABLE orders (id uuid PRIMARY KEY, "ownerId" varchar NOT NULL,
      instrument varchar NOT NULL, side varchar NOT NULL, price numeric(18,2) NOT NULL,
      quantity numeric(18,8) NOT NULL, "remainingQuantity" numeric(18,8) NOT NULL,
      status varchar NOT NULL DEFAULT 'open', "createdAt" timestamptz NOT NULL)`);
    const user = randomUUID();
    await source.query('INSERT INTO users VALUES ($1,$2,$3,NULL)', [
      user,
      'legacy@test.local',
      'preserved-hash',
    ]);
    await source.query(`INSERT INTO orders VALUES ($1,$2,'ABC','buy',12.34,0.5,0.5,'open',now())`, [
      randomUUID(),
      user,
    ]);
    const snapshot = () =>
      source.query(
        'SELECT to_jsonb(u) AS user, to_jsonb(o) AS order FROM users u CROSS JOIN orders o',
      );
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(migrate(source, 'run')).rejects.toThrow('Unsupported starter schema');
      expect(await snapshot()).toEqual(before);
      expect(await source.query("SELECT to_regclass('migrations') AS history")).toEqual([
        { history: null },
      ]);
    }
  } finally {
    await source.destroy();
    await database.destroy();
  }
});
