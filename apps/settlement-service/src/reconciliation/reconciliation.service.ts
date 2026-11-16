import { boundedRead } from '../database/bounded-read';
import { EntityManager } from 'typeorm';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ASSET_SCALES, Asset, formatAmount } from '../ledger/amount';
import { EngineOrdersClient } from './engine-orders.client';
import { EngineTradesClient, Period } from './engine-trades.client';
import { scanStuckReservations, scanUnreservedOrders } from './stuck-reservations';
import { ledgerTrades } from './ledger-trades.reader';
import { compareStreams, Discrepancy, DiscrepancyType, Totals } from './trade-comparison';

const MAX_DISCREPANCIES = 1000;

interface AssetRow {
  asset: Asset;
  debit: string;
  credit: string;
  balance_sum: string;
  replay_mismatches: string;
}

interface LeakRow {
  user_id: string;
  asset: Asset;
  reserved: string;
  expected: string;
  total: string;
}

export interface ReconciliationReport {
  period: Period;
  ok: boolean;
  counts: Record<DiscrepancyType, number> & {
    engineTrades: number;
    ledgerTrades: number;
    matched: number;
  };
  perInstrument: {
    instrument: string;
    engine: Record<keyof Totals, string>;
    ledger: Record<keyof Totals, string>;
    equal: boolean;
  }[];
  perAsset: {
    asset: Asset;
    debit: string;
    credit: string;
    balanced: boolean;
    balanceSum: string;
    replayMismatches: number;
  }[];
  discrepancies: Discrepancy[];
  truncated: boolean;
}

@Injectable()
export class ReconciliationService {
  private readonly graceMs: number;

  constructor(
    private readonly source: DataSource,
    private readonly engine: EngineTradesClient,
    private readonly orders: EngineOrdersClient,
    config: ConfigService,
  ) {
    this.graceMs = config.getOrThrow('SETTLEMENT_GRACE_MS');
  }

  // Локальний guard доповнює спільний транзакційний lock.
  private running = false;

  async run(period: Period, cancelled?: AbortSignal): Promise<ReconciliationReport> {
    if (this.running)
      throw new ConflictException({
        code: 'RECONCILIATION_RUNNING',
        message: 'Звірка вже виконується',
      });
    this.running = true;
    try {
      const deadline = AbortSignal.timeout(30000);
      const signal = cancelled ? AbortSignal.any([deadline, cancelled]) : deadline;
      try {
        return await this.compare(period, signal);
      } catch (error) {
        if (signal.aborted) throw new ServiceUnavailableException('Час звірки вичерпано');
        throw error;
      }
    } finally {
      this.running = false;
    }
  }

  private async compare(period: Period, signal: AbortSignal): Promise<ReconciliationReport> {
    // Один snapshot для угод, DLQ, балансів і резервів: звіт не бачить половини запису.
    return boundedRead(this.source, signal, async (reader) => {
      const db = reader as unknown as Pick<EntityManager, 'query'>;
      const [{ locked }] = await db.query('SELECT pg_try_advisory_xact_lock(734021, 4) AS locked');
      if (!locked)
        throw new ConflictException({
          code: 'RECONCILIATION_RUNNING',
          message: 'Звірка вже виконується',
        });
      await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const orders = {
        terminal: (ids: string[]) => this.orders.terminal(ids, signal),
        live: (after: string, instrument?: string) => this.orders.live(after, instrument, signal),
      };
      const now = Date.now();
      const comparison = await compareStreams(
        this.engine.trades(period, signal),
        ledgerTrades(db, period),
        {
          // Запит на кожну відсутню угоду: пам'ять не залежить від розміру DLQ.
          isFailed: async (tradeId) =>
            (
              await db.query('SELECT 1 FROM settlement_failures WHERE trade_id = $1 LIMIT 1', [
                tradeId,
              ])
            ).length > 0,
          now,
          graceMs: this.graceMs,
          limit: MAX_DISCREPANCIES,
        },
      );

      const assets: AssetRow[] = await db.query(
        `SELECT a.code AS asset, p.debit, p.credit, b.balance_sum, COALESCE(r.mismatches, 0) AS replay_mismatches
         FROM assets a
         LEFT JOIN (SELECT asset,
             COALESCE(sum(amount) FILTER (WHERE direction = 'debit'), 0) AS debit,
             COALESCE(sum(amount) FILTER (WHERE direction = 'credit'), 0) AS credit
           FROM postings GROUP BY asset) p ON p.asset = a.code
         LEFT JOIN (SELECT asset, sum(balance) AS balance_sum FROM accounts GROUP BY asset) b
           ON b.asset = a.code
         LEFT JOIN (SELECT x.asset, count(*) AS mismatches FROM accounts x
           LEFT JOIN (SELECT account_id,
               sum(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS net
             FROM postings GROUP BY account_id) n ON n.account_id = x.id
           WHERE x.balance <> COALESCE(n.net, 0) GROUP BY x.asset) r ON r.asset = a.code
         ORDER BY a.code`,
      );
      const leaks: LeakRow[] = await db.query(
        `SELECT COALESCE(a.user_id,r.user_id) AS user_id, COALESCE(a.asset,r.asset) AS asset,
           COALESCE(a.balance,0)::text AS reserved, COALESCE(r.remaining,0)::text AS expected,
           count(*) OVER()::text AS total
         FROM (SELECT user_id,asset,balance FROM accounts WHERE kind='reserved') a
         FULL JOIN (SELECT user_id,asset,sum(remaining) AS remaining FROM reservations
           WHERE status='active' GROUP BY user_id,asset) r
           ON r.user_id=a.user_id AND r.asset=a.asset
         WHERE a.balance IS DISTINCT FROM COALESCE(r.remaining,0)
         ORDER BY user_id,asset LIMIT ${MAX_DISCREPANCIES}`,
      );

      const discrepancies = comparison.discrepancies;
      comparison.counts.reservation_leak += Number(leaks[0]?.total ?? 0);
      for (const leak of leaks) {
        if (discrepancies.length < MAX_DISCREPANCIES)
          discrepancies.push({
            type: 'reservation_leak',
            tradeId: null,
            instrument: null,
            executedAt: null,
            expected: { userId: leak.user_id, asset: leak.asset, reserved: leak.expected },
            actual: { userId: leak.user_id, asset: leak.asset, reserved: leak.reserved },
          });
      }

      // Як і витік, перевіряється на момент звірки, а не за період; `instrument` звужує вибірку.
      const stuck = await scanStuckReservations(db, orders, {
        instrument: period.instrument,
        now,
        graceMs: this.graceMs,
        limit: Math.max(0, MAX_DISCREPANCIES - discrepancies.length),
      });
      comparison.counts.stuck_reservation += stuck.count;
      discrepancies.push(...stuck.found);
      const unreserved = await scanUnreservedOrders(db, orders, {
        instrument: period.instrument,
        now,
        graceMs: this.graceMs,
        limit: Math.max(0, MAX_DISCREPANCIES - discrepancies.length),
      });
      comparison.counts.unreserved_order += unreserved.count;
      discrepancies.push(...unreserved.found);

      const perAsset = assets.map((row) => ({
        asset: row.asset,
        debit: row.debit ?? '0',
        credit: row.credit ?? '0',
        balanced: (row.debit ?? '0') === (row.credit ?? '0'),
        balanceSum: row.balance_sum ?? '0',
        replayMismatches: Number(row.replay_mismatches),
      }));
      const { counts } = comparison;
      const unresolved = Object.entries(counts).some(
        ([type, count]) => type !== 'pending' && count > 0,
      );
      return {
        period,
        ok:
          !unresolved &&
          perAsset.every(
            ({ balanced, balanceSum, replayMismatches }) =>
              balanced && balanceSum === '0' && replayMismatches === 0,
          ),
        counts: {
          ...counts,
          engineTrades: sum(comparison.engine),
          ledgerTrades: sum(comparison.ledger),
          matched: comparison.matched,
        },
        perInstrument: [...new Set([...comparison.engine.keys(), ...comparison.ledger.keys()])]
          .sort()
          .map((instrument) => {
            const engine = comparison.engine.get(instrument) ?? empty;
            const ledger = comparison.ledger.get(instrument) ?? empty;
            return {
              instrument,
              engine: format(engine, instrument as Asset),
              ledger: format(ledger, instrument as Asset),
              equal:
                engine.count === ledger.count &&
                engine.quantity === ledger.quantity &&
                engine.quote === ledger.quote,
            };
          }),
        perAsset,
        discrepancies,
        truncated:
          Object.values(counts).reduce((total, count) => total + count, 0) > discrepancies.length,
      };
    });
  }
}

const empty: Totals = { count: 0, quantity: 0n, quote: 0n };
const sum = (totals: Map<string, Totals>) =>
  [...totals.values()].reduce((total, { count }) => total + count, 0);

function format(totals: Totals, instrument: Asset): Record<keyof Totals, string> {
  return {
    count: String(totals.count),
    quantity: formatAmount(totals.quantity, ASSET_SCALES[instrument]),
    quote: formatAmount(totals.quote, ASSET_SCALES.USD),
  };
}
