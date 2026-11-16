import { MigrationInterface, QueryRunner } from 'typeorm';

export class LedgerLinks1793980800002 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    // Діагностика перед DDL: жодну стару проводку не переписуємо й не видаляємо.
    const [row] = await db.query(`SELECT
      (SELECT count(*) FROM postings p JOIN accounts a ON a.id=p.account_id WHERE p.asset<>a.asset) AS assets,
      (SELECT count(*) FROM settled_trades s LEFT JOIN journal_entries j ON j.id=s.entry_id
        WHERE j.id IS NULL OR j.type<>'trade' OR j.trade_id IS DISTINCT FROM s.trade_id) AS settlements,
      (SELECT count(*) FROM journal_entries j LEFT JOIN settled_trades s
        ON s.entry_id=j.id AND s.trade_id=j.trade_id WHERE j.type='trade' AND s.trade_id IS NULL) AS journals`);
    if (Object.values(row).some((value) => BigInt(String(value)) !== 0n))
      throw new Error(
        `Ledger link preflight failed: ${JSON.stringify(row)}; preserve and reconcile the database before retrying`,
      );
    await db.query('ALTER TABLE accounts ADD CONSTRAINT accounts_id_asset_key UNIQUE(id,asset)');
    await db.query(`ALTER TABLE postings ADD CONSTRAINT postings_account_asset_fk
      FOREIGN KEY(account_id,asset) REFERENCES accounts(id,asset) NOT VALID`);
    await db.query('ALTER TABLE postings VALIDATE CONSTRAINT postings_account_asset_fk');
    await db.query(
      'ALTER TABLE journal_entries ADD CONSTRAINT journal_trade_id_key UNIQUE(trade_id,id)',
    );
    await db.query(
      'ALTER TABLE settled_trades ADD CONSTRAINT settled_trade_entry_key UNIQUE(trade_id,entry_id)',
    );
    // MATCH FULL забороняє NULL entry_id на COMMIT, але дозволяє чинний INSERT → UPDATE у тій самій TX.
    await db.query(`ALTER TABLE settled_trades ADD CONSTRAINT settled_journal_fk
      FOREIGN KEY(trade_id,entry_id) REFERENCES journal_entries(trade_id,id)
      MATCH FULL DEFERRABLE INITIALLY DEFERRED NOT VALID`);
    await db.query('ALTER TABLE settled_trades VALIDATE CONSTRAINT settled_journal_fk');
    await db.query(`ALTER TABLE journal_entries ADD CONSTRAINT journal_settled_fk
      FOREIGN KEY(trade_id,id) REFERENCES settled_trades(trade_id,entry_id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID`);
    await db.query('ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_settled_fk');
    await db.query(`ALTER TABLE journal_entries ADD CONSTRAINT journal_trade_type
      CHECK ((type='trade')=(trade_id IS NOT NULL)) NOT VALID`);
    await db.query('ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_trade_type');
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query('ALTER TABLE journal_entries DROP CONSTRAINT journal_trade_type');
    await db.query('ALTER TABLE journal_entries DROP CONSTRAINT journal_settled_fk');
    await db.query('ALTER TABLE settled_trades DROP CONSTRAINT settled_journal_fk');
    await db.query('ALTER TABLE settled_trades DROP CONSTRAINT settled_trade_entry_key');
    await db.query('ALTER TABLE journal_entries DROP CONSTRAINT journal_trade_id_key');
    await db.query('ALTER TABLE postings DROP CONSTRAINT postings_account_asset_fk');
    await db.query('ALTER TABLE accounts DROP CONSTRAINT accounts_id_asset_key');
  }
}
