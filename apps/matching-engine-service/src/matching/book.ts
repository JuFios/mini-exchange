export type Side = 'buy' | 'sell';

export interface BookOrder {
  readonly id: string;
  readonly ownerId: string;
  readonly side: Side;
  readonly price: bigint;
  readonly quantity: bigint;
  readonly remaining: bigint;
  readonly prioritySeq: bigint;
}

// One instrument's active orders, with positive remaining quantities.
export interface Book {
  readonly bids: readonly BookOrder[];
  readonly asks: readonly BookOrder[];
}

export function compareOrders(a: BookOrder, b: BookOrder): number {
  if (a.price === b.price) {
    if (a.prioritySeq === b.prioritySeq) return 0;
    return a.prioritySeq < b.prioritySeq ? -1 : 1;
  }
  const lowerPriceFirst = a.side === 'sell';
  return (a.price < b.price) === lowerPriceFirst ? -1 : 1;
}

export interface LevelChange {
  side: Side;
  price: bigint;
  quantity: bigint;
  orders: number;
}

export function changedLevels(book: Book, touched: readonly BookOrder[]): LevelChange[] {
  const levels = { buy: new Map<bigint, LevelChange>(), sell: new Map<bigint, LevelChange>() };
  for (const { side, price } of touched) {
    levels[side].set(price, { side, price, quantity: 0n, orders: 0 });
  }

  for (const [side, orders] of [['buy', book.bids], ['sell', book.asks]] as const) {
    if (levels[side].size === 0) continue;
    for (const order of orders) {
      const level = levels[side].get(order.price);
      if (level) {
        level.quantity += order.remaining;
        level.orders++;
      }
    }
  }
  return [...levels.buy.values(), ...levels.sell.values()];
}
