import { migrate } from '../../src/database/migrate';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { TradesService } from '../../src/trades/trades.service';
import { ledgerApp, tradeFixture } from '../ledger-app';
import { reserveTrade } from '../stream-fixtures';

const ledger = ledgerApp();

it('preserves every populated ledger row during upgrade and rejects corrupt links without modifying data', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  await ledger.app().get(TradesService).settle(trade);
  await ledger.app().get(ReservationsService).release(trade.buyOrderId);
  const source = ledger.source();
  const tables = ['accounts', 'postings', 'journal_entries', 'settled_trades', 'reservations'];
  const snapshot = async () =>
    Promise.all(
      tables.map((table) =>
        source.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`),
      ),
    );
  const before = await snapshot();
  await migrate(source, 'revert');
  await migrate(source, 'revert');
  await migrate(source, 'run');
  expect(await snapshot()).toEqual(before);

  await expect(
    source.query("UPDATE postings SET asset='XYZ' WHERE id=(SELECT min(id) FROM postings)"),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(source.query('UPDATE settled_trades SET entry_id=NULL')).rejects.toMatchObject({
    code: '23503',
  });
  await migrate(source, 'revert');
  await source.query("UPDATE postings SET asset='XYZ' WHERE id=(SELECT min(id) FROM postings)");
  const corrupt = await snapshot();
  await expect(migrate(source, 'run')).rejects.toThrow('Ledger link preflight failed');
  expect(await snapshot()).toEqual(corrupt);
  expect(await source.query('SELECT count(*)::int AS n FROM migrations')).toEqual([{ n: 2 }]);
  await source.query('UPDATE postings p SET asset=a.asset FROM accounts a WHERE a.id=p.account_id');
  await migrate(source, 'run');
  expect(await snapshot()).toEqual(before);
});
