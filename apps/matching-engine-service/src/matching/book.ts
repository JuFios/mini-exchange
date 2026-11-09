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

// Активні заявки одного інструмента з додатними залишками.
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
  return a.price < b.price === lowerPriceFirst ? -1 : 1;
}

export interface LevelChange {
  side: Side;
  price: bigint;
  quantity: bigint;
  orders: number;
}

// Клієнт `/market` тримає стільки найкращих рівнів на сторону, скільки віддає snapshot.
export const BOOK_DEPTH = 50;

function windowPrices(orders: readonly BookOrder[], side: Side, depth: number): Set<bigint> {
  const prices = [...new Set(orders.map(({ price }) => price))];
  prices.sort((a, b) => {
    if (a === b) return 0;
    return a < b === (side === 'sell') ? -1 : 1;
  });
  return new Set(prices.slice(0, depth));
}

/**
 * Рівні, які змінила команда, плюс рівні, що ввійшли у вікно `depth` найкращих: коли найкращий
 * рівень зникає, наступний за вікном стає видимим, а клієнт, який тримає лише вікно, його не має.
 */
export function changedLevels(
  before: Book,
  after: Book,
  touched: readonly BookOrder[],
  depth = BOOK_DEPTH,
): LevelChange[] {
  const levels = { buy: new Map<bigint, LevelChange>(), sell: new Map<bigint, LevelChange>() };
  const zero = (side: Side, price: bigint): LevelChange => ({
    side,
    price,
    quantity: 0n,
    orders: 0,
  });
  for (const { side, price } of touched) levels[side].set(price, zero(side, price));

  for (const [side, orders, previous] of [
    ['buy', after.bids, before.bids],
    ['sell', after.asks, before.asks],
  ] as const) {
    const visible = windowPrices(previous, side, depth);
    for (const price of windowPrices(orders, side, depth))
      if (!visible.has(price) && !levels[side].has(price))
        levels[side].set(price, zero(side, price));
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
