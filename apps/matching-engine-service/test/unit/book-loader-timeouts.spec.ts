import { EntityManager } from 'typeorm';
import { BookLoader } from '../../src/engine/book-loader';

function fakeDb(queries: string[]) {
  const state = {
    legacy_verified: true,
    status: 'active',
    last_applied_seq: '0',
    resting_count: '0',
    resting_quantity: '0',
    resting_bid_count: '0',
    resting_ask_count: '0',
    resting_bid_lots: '0',
    resting_ask_lots: '0',
  };
  return {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.startsWith('SELECT * FROM instrument_state') ? [state] : [];
    },
    getRepository: () => ({ find: async () => [] }),
  } as unknown as EntityManager;
}

it('relaxes session timeouts for the recovery transaction of a large book', async () => {
  const queries: string[] = [];
  await new BookLoader().load(fakeDb(queries), 'ABC');
  const text = queries.join('\n');
  // Завантаження й сортування великої книги довше за 5 с і 2 с простою сесії за замовчуванням.
  expect(text).toContain("SET LOCAL statement_timeout='10s'");
  expect(text).toContain("SET LOCAL idle_in_transaction_session_timeout='10s'");
});
