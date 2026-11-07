import { migrate } from '../../src/database/migrate';
import { testDatabase } from '../test-database';

interface DbColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

const database = testDatabase();
const source = database.source();

beforeAll(async () => {
  await database.create();
  await source.initialize();
  await migrate(source, 'run');
});

afterAll(async () => {
  try {
    if (source.isInitialized) await source.destroy();
  } finally {
    await database.destroy();
  }
});

// Схема керується лише міграціями (`synchronize: false`), тож відображення entities
// на таблиці перевіряємо тут, а не під час першого запису в наступному PR.
it('maps every table and column created by the migrations to an entity, with the same types', async () => {
  const columns = (await source.query(`
    SELECT table_name, column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'migrations'
  `)) as DbColumn[];
  const primaryKeys = (await source.query(`
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
  `)) as { table_name: string; column_name: string }[];

  const tables = [...new Set(columns.map((column) => column.table_name))].sort();
  expect(source.entityMetadatas.map((entity) => entity.tableName).sort()).toEqual(tables);

  for (const entity of source.entityMetadatas) {
    const actual = columns.filter((column) => column.table_name === entity.tableName);
    expect(entity.columns.map((column) => column.databaseName).sort()).toEqual(
      actual.map((column) => column.column_name).sort(),
    );
    expect(entity.primaryColumns.map((column) => column.databaseName).sort()).toEqual(
      primaryKeys
        .filter((key) => key.table_name === entity.tableName)
        .map((key) => key.column_name)
        .sort(),
    );

    for (const column of entity.columns) {
      const description = `${entity.tableName}.${column.databaseName}`;
      const found = actual.find((candidate) => candidate.column_name === column.databaseName)!;
      expect({ description, type: found.data_type }).toEqual({
        description,
        type: source.driver.normalizeType(column),
      });
      expect({ description, nullable: found.is_nullable === 'YES' }).toEqual({
        description,
        nullable: column.isNullable,
      });
      if (found.data_type === 'numeric') {
        expect({
          description,
          precision: found.numeric_precision,
          scale: found.numeric_scale,
        }).toEqual({
          description,
          precision: column.precision,
          scale: column.scale ?? 0,
        });
      }
      if (found.data_type === 'character varying') {
        expect({ description, length: found.character_maximum_length }).toEqual({
          description,
          length: column.length ? Number(column.length) : null,
        });
      }
    }
  }
});
