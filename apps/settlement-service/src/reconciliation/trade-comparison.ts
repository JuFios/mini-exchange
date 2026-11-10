import { ASSET_SCALES, Asset, parseAmount } from '../ledger/amount';
import { PostingBuilder } from '../ledger/posting-builder';
import { describeTrade } from '../trades/trades.service';

export interface EngineTrade {
  tradeId: string;
  instrument: string;
  executedAt: string;
  price: string;
  quantity: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  buyLimitPrice: string;
  baseAsset: Asset;
  quoteAsset: Asset;
}

export interface PostingRow {
  userId: string | null;
  asset: Asset;
  kind: string;
  direction: 'debit' | 'credit';
  amount: string;
}

export interface LedgerTrade {
  tradeId: string;
  instrument: string;
  executedAt: string;
  payloadHash: string;
  postings: PostingRow[];
}

export type DiscrepancyType =
  | 'pending'
  | 'missing'
  | 'failed'
  | 'orphan'
  | 'amount_mismatch'
  | 'duplicate'
  | 'payload_conflict'
  | 'reservation_leak'
  | 'stuck_reservation';

export interface Discrepancy {
  type: DiscrepancyType;
  tradeId: string | null;
  instrument: string | null;
  executedAt: string | null;
  expected: unknown;
  actual: unknown;
}

export interface Totals {
  count: number;
  quantity: bigint;
  quote: bigint;
}

const key = (p: PostingRow) =>
  `${p.direction}:${p.asset}:${p.userId ?? ''}:${p.kind}:${BigInt(p.amount)}`;

export function expectedPostings(trade: EngineTrade): PostingRow[] {
  const { trade: canonical, price, quantity, buyLimit } = describeTrade(trade);
  return PostingBuilder.trade({
    buyerUserId: canonical.buyerUserId,
    sellerUserId: canonical.sellerUserId,
    baseAsset: canonical.baseAsset,
    quoteAsset: canonical.quoteAsset,
    price,
    quantity,
    buyLimit,
  }).map(({ userId, asset, kind, direction, amount }) => ({
    userId,
    asset,
    kind,
    direction,
    amount: amount.toString(),
  }));
}

/** Кількість і сума котирування, які бачить ledger: продавець віддає base і отримує p·q в quote. */
export function ledgerAmounts(trade: LedgerTrade): { quantity: bigint; quote: bigint } {
  const given = trade.postings.find(
    (p) => p.direction === 'debit' && p.kind === 'reserved' && p.asset !== 'USD',
  );
  const received = trade.postings.find(
    (p) =>
      p.direction === 'credit' &&
      p.kind === 'available' &&
      p.asset === 'USD' &&
      p.userId === given?.userId,
  );
  return { quantity: BigInt(given?.amount ?? 0), quote: BigInt(received?.amount ?? 0) };
}

export function engineAmounts(trade: EngineTrade): { quantity: bigint; quote: bigint } {
  const quantity = parseAmount(trade.quantity, ASSET_SCALES[trade.baseAsset]);
  // Ціна має 2 знаки, кількість 8: добуток уже в одиницях 1e-10.
  return { quantity, quote: parseAmount(trade.price, 2) * quantity };
}

function discrepancy(
  type: DiscrepancyType,
  trade: { tradeId: string; instrument: string; executedAt: string },
  expected: unknown,
  actual: unknown,
): Discrepancy {
  const { tradeId, instrument, executedAt } = trade;
  return { type, tradeId, instrument, executedAt, expected, actual };
}

/** Порівнює угоду engine з угодою ledger; `undefined` означає повний збіг. */
export function compareTrade(engine: EngineTrade, ledger: LedgerTrade): Discrepancy | undefined {
  const expected = expectedPostings(engine).map(key).sort();
  const actual = ledger.postings.map(key).sort();
  if (describeTrade(engine).hash !== ledger.payloadHash)
    return discrepancy(
      'payload_conflict',
      engine,
      { hash: describeTrade(engine).hash },
      {
        hash: ledger.payloadHash,
      },
    );
  if (expected.join() === actual.join()) return undefined;
  // Кожна очікувана проводка двічі: запис виконано повторно.
  if (actual.join() === [...expected, ...expected].sort().join())
    return discrepancy('duplicate', engine, expected, actual);
  return discrepancy('amount_mismatch', engine, expected, actual);
}

export async function absentTrade(
  engine: EngineTrade,
  context: { isFailed: (tradeId: string) => Promise<boolean>; now: number; graceMs: number },
): Promise<Discrepancy> {
  const type: DiscrepancyType = (await context.isFailed(engine.tradeId))
    ? 'failed'
    : context.now - Date.parse(engine.executedAt) < context.graceMs
      ? 'pending'
      : 'missing';
  return discrepancy(type, engine, 'settled', 'absent');
}

export const orphanTrade = (ledger: LedgerTrade): Discrepancy =>
  discrepancy('orphan', ledger, 'present in engine', 'absent');

export interface Comparison {
  discrepancies: Discrepancy[];
  counts: Record<DiscrepancyType, number>;
  engine: Map<string, Totals>;
  ledger: Map<string, Totals>;
  matched: number;
}

const add = (map: Map<string, Totals>, instrument: string, quantity: bigint, quote: bigint) => {
  const totals = map.get(instrument) ?? { count: 0, quantity: 0n, quote: 0n };
  map.set(instrument, {
    count: totals.count + 1,
    quantity: totals.quantity + quantity,
    quote: totals.quote + quote,
  });
};

const order = (a: { executedAt: string; tradeId: string }, b: typeof a): number =>
  a.executedAt < b.executedAt
    ? -1
    : a.executedAt > b.executedAt
      ? 1
      : a.tradeId < b.tradeId
        ? -1
        : Number(a.tradeId > b.tradeId);

/**
 * Зливає два потоки, відсортовані за (executedAt, tradeId). Пам'ять не залежить від
 * кількості угод: тримаються лише поточні елементи, лічильники й межа списку розбіжностей.
 */
export async function compareStreams(
  engineTrades: AsyncIterable<EngineTrade>,
  ledgerTrades: AsyncIterable<LedgerTrade>,
  context: {
    isFailed: (tradeId: string) => Promise<boolean>;
    now: number;
    graceMs: number;
    limit: number;
  },
): Promise<Comparison> {
  const result: Comparison = {
    discrepancies: [],
    counts: {
      pending: 0,
      missing: 0,
      failed: 0,
      orphan: 0,
      amount_mismatch: 0,
      duplicate: 0,
      payload_conflict: 0,
      reservation_leak: 0,
      stuck_reservation: 0,
    },
    engine: new Map(),
    ledger: new Map(),
    matched: 0,
  };
  const record = (found: Discrepancy | undefined) => {
    if (!found) return;
    result.counts[found.type]++;
    if (result.discrepancies.length < context.limit) result.discrepancies.push(found);
  };
  const engineIterator = engineTrades[Symbol.asyncIterator]();
  const ledgerIterator = ledgerTrades[Symbol.asyncIterator]();
  let engine = await engineIterator.next();
  let ledger = await ledgerIterator.next();
  while (!engine.done || !ledger.done) {
    const side = engine.done ? 1 : ledger.done ? -1 : order(engine.value, ledger.value);
    if (side < 0) {
      const { quantity, quote } = checked(engine.value!, () => engineAmounts(engine.value!));
      add(result.engine, engine.value!.instrument, quantity, quote);
      record(await absentTrade(engine.value!, context));
      engine = await engineIterator.next();
    } else if (side > 0) {
      const { quantity, quote } = ledgerAmounts(ledger.value!);
      add(result.ledger, ledger.value!.instrument, quantity, quote);
      record(orphanTrade(ledger.value!));
      ledger = await ledgerIterator.next();
    } else {
      const amounts = checked(engine.value!, () => engineAmounts(engine.value!));
      add(result.engine, engine.value!.instrument, amounts.quantity, amounts.quote);
      const settled = ledgerAmounts(ledger.value!);
      add(result.ledger, ledger.value!.instrument, settled.quantity, settled.quote);
      const found = checked(engine.value!, () => compareTrade(engine.value!, ledger.value!));
      if (found) record(found);
      else result.matched++;
      engine = await engineIterator.next();
      ledger = await ledgerIterator.next();
    }
  }
  return result;
}

// Хибний рядок engine не ховаємо в розбіжність, але називаємо: решта звіту була б неповною.
// Помилки БД і HTTP проходять без змін, бо до угоди вони не стосуються.
function checked<T>(trade: EngineTrade, compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    throw new Error(
      `Engine trade ${trade.tradeId} cannot be compared: ${(error as Error).message}`,
    );
  }
}
