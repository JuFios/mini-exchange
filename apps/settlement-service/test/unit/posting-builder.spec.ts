import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSET_SCALES, parseAmount } from '../../src/ledger/amount';
import { Posting, PostingBuilder } from '../../src/ledger/posting-builder';

const input = {
  buyerUserId: 'buyer',
  sellerUserId: 'seller',
  baseAsset: 'ABC',
  quoteAsset: 'USD',
  price: parseAmount('100.00', 2),
  quantity: parseAmount('0.5', 8),
  buyLimit: parseAmount('101.00', 2),
} as const;

it('settles at the maker price and refunds the difference to the buyer', () => {
  expect(PostingBuilder.trade(input)).toEqual([
    { userId: 'seller', asset: 'ABC', kind: 'reserved', direction: 'debit', amount: 50_000_000n },
    { userId: 'buyer', asset: 'ABC', kind: 'available', direction: 'credit', amount: 50_000_000n },
    {
      userId: 'buyer',
      asset: 'USD',
      kind: 'reserved',
      direction: 'debit',
      amount: 505_000_000_000n,
    },
    {
      userId: 'seller',
      asset: 'USD',
      kind: 'available',
      direction: 'credit',
      amount: 500_000_000_000n,
    },
    {
      userId: 'buyer',
      asset: 'USD',
      kind: 'available',
      direction: 'credit',
      amount: 5_000_000_000n,
    },
  ]);
});

it('balances every journal entry by asset and rejects an imbalance', () => {
  const wallet = { userId: 'buyer', asset: 'USD' } as const;
  const entries: Posting[][] = [
    PostingBuilder.transfer('genesis', wallet, 200n),
    PostingBuilder.transfer('reserve', wallet, 200n),
    PostingBuilder.transfer('release', wallet, 200n),
    PostingBuilder.trade(input),
    PostingBuilder.trade({ ...input, buyLimit: input.price }),
  ];
  for (const entry of entries) {
    for (const asset of Object.keys(ASSET_SCALES)) {
      const legs = entry.filter((posting) => posting.asset === asset);
      const total = (direction: Posting['direction']) =>
        legs.filter((p) => p.direction === direction).reduce((sum, p) => sum + p.amount, 0n);
      expect(total('debit')).toBe(total('credit'));
    }
  }
  expect(entries[4]).toHaveLength(4);
  expect(() => PostingBuilder.balanced(entries[3].slice(0, -1))).toThrow('Unbalanced postings');
});

it('supports each engine instrument base and quote asset at scales 8 and 10', () => {
  const migration = readFileSync(
    join(__dirname, '../../../matching-engine-service/src/migrations/1793980800001-instruments.ts'),
    'utf8',
  );
  const pairs = [...migration.matchAll(/\('[^']+', '([^']+)', '([^']+)', 0\.01, 0\.00000001,/g)];
  expect(pairs.map(([, base, quote]) => [base, quote])).toEqual([
    ['ABC', 'USD'],
    ['XYZ', 'USD'],
  ]);
  for (const [, base, quote] of pairs) {
    expect(ASSET_SCALES[base as keyof typeof ASSET_SCALES]).toBe(8);
    expect(ASSET_SCALES[quote as keyof typeof ASSET_SCALES]).toBe(10);
  }
});
