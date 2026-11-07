import {
  emptyBook,
  lot,
  multiFill,
  resting,
  samePrice,
  selfCross,
  submit,
} from '../helpers/matching-fixtures';
import { ReferenceMatcher } from '../helpers/reference-matcher';

describe('reference matching fixtures', () => {
  it('fills three makers in FIFO order and leaves the third partial', () => {
    const ref = new ReferenceMatcher(multiFill.book.asks);
    expect(ref.apply(multiFill.command).trades).toMatchObject([
      {
        tradeId: '802d8869-5d8b-5111-a562-c48ebe230ba1',
        sellOrderId: 'order-1',
        price: 10_000n,
        quantity: 50_000_000n,
      },
      {
        tradeId: 'afad13b4-bd02-5243-9e8a-6bfe21c6d525',
        sellOrderId: 'order-2',
        price: 10_000n,
        quantity: 70_000_000n,
      },
      {
        tradeId: 'edde641e-1b00-5b7b-9710-755f299cbfe0',
        sellOrderId: 'order-3',
        price: 10_100n,
        quantity: 80_000_000n,
      },
    ]);
    expect(ref.book()).toEqual({
      bids: [],
      asks: [{ ...multiFill.book.asks[2], remaining: 20_000_000n }],
    });
    expect(ref.orders.get('order-3')?.status).toBe('partially_filled');
    expect(ref.orders.get('order-4')?.status).toBe('filled');
  });

  it('matches the lower sequence at the same price', () => {
    const ref = new ReferenceMatcher(samePrice.book.asks);
    expect(ref.apply(samePrice.command).trades).toMatchObject([{ sellOrderId: 'order-3' }]);
    expect(ref.book()).toEqual({ bids: [], asks: [samePrice.book.asks[0]] });
  });

  it('cancels the remainder after a third-party fill at the better price', () => {
    const ref = new ReferenceMatcher(selfCross.book.asks);
    expect(ref.apply(selfCross.command).trades).toMatchObject([
      { sellOrderId: 'order-2', price: 9_900n, quantity: lot },
    ]);
    expect(ref.book()).toEqual({ bids: [], asks: [selfCross.book.asks[0]] });
    expect(ref.orders.get('order-3')).toMatchObject({ status: 'cancelled', remaining: lot });
  });

  it('cancels an incoming order that only crosses its own ask', () => {
    const ownAsk = resting(submit(1n, 'sell', 10_000n, lot, 'X'));
    const ref = new ReferenceMatcher([ownAsk]);
    expect(ref.apply(submit(2n, 'buy', 10_000n, lot, 'X')).trades).toEqual([]);
    expect(ref.book()).toEqual({ bids: [], asks: [ownAsk] });
    expect(ref.orders.get('order-2')?.status).toBe('cancelled');
  });

  it('fills a crossing buy at the resting sell price', () => {
    const ref = new ReferenceMatcher([resting(submit(1n, 'sell', 10_000n, lot, 'A'))]);
    expect(ref.apply(submit(2n, 'buy', 10_100n, lot, 'B')).trades).toMatchObject([
      { price: 10_000n, quantity: lot },
    ]);
    expect(ref.book()).toEqual(emptyBook);
  });

  it('rests the unfilled remainder of a larger buy', () => {
    const ref = new ReferenceMatcher([resting(submit(1n, 'sell', 10_000n, lot / 2n, 'A'))]);
    const buy = submit(2n, 'buy', 10_000n, lot, 'B');
    expect(ref.apply(buy).trades).toMatchObject([{ price: 10_000n, quantity: lot / 2n }]);
    expect(ref.book()).toEqual({ asks: [], bids: [{ ...resting(buy), remaining: lot / 2n }] });
    expect(ref.orders.get('order-2')?.status).toBe('partially_filled');
  });

  it('fills the earlier arrival among equal-priced makers', () => {
    const earlier = resting(submit(1n, 'sell', 10_000n, lot, 'A'));
    const later = resting(submit(2n, 'sell', 10_000n, lot, 'A'));
    const ref = new ReferenceMatcher([later, earlier]);
    expect(ref.apply(submit(3n, 'buy', 10_000n, lot, 'B')).trades).toMatchObject([
      { sellOrderId: earlier.id },
    ]);
    expect(ref.book()).toEqual({ bids: [], asks: [later] });
  });
});
