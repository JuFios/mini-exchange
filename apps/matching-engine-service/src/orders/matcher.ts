import type { BookOrder } from '../matching/book';
import { formatPrice, formatQuantity, parsePrice, parseQuantity } from '../matching/decimal';
import { apply, uuidv5 } from '../matching/engine';
import type { Order } from './entities/order.entity';
import type { BookSnapshot, MatchResult } from './order-book.types';

type MatcherOrder = Order & { priority_seq?: bigint };

const UNSEQUENCED_TRADE_NAMESPACE = '4b50a677-1972-442c-8660-32f2b3416d47';

/**
 * Чиста функція зіставлення заявки з наявною книгою (price-time priority).
 * Не звертається до жодного зовнішнього стану — приймає знімок книги,
 * повертає результат. Побічні ефекти (запис у реальну книгу, персистенція)
 * — відповідальність викликача.
 */
export function matchOrder(book: BookSnapshot, incoming: MatcherOrder): MatchResult {
  const orders: MatcherOrder[] = [...book.bids, ...book.asks, incoming];
  const sequencedCount = orders.filter(({ priority_seq }) => priority_seq !== undefined).length;
  // Номер надходження і час створення несумісні: змішаний знімок не має однозначного FIFO.
  if (sequencedCount !== 0 && sequencedCount !== orders.length) {
    throw new Error('Book snapshot mixes orders with and without a priority sequence');
  }
  const sequenced = sequencedCount === orders.length;
  // Без номерів надходження пріоритет — (час створення, позиція у знімку). Це той самий
  // порядок, що дало б стабільне сортування, але за один прохід без сортування книги.
  const rank = (order: MatcherOrder, index: number): bigint => {
    if (sequenced) return order.priority_seq!;
    const createdAt = order.createdAt.getTime();
    if (!Number.isFinite(createdAt))
      throw new Error(`Order ${order.id} has an invalid creation time`);
    return BigInt(createdAt) * BigInt(orders.length) + BigInt(index);
  };
  const byId = new Map(
    orders.map((order, index) => [
      order.id,
      {
        original: order,
        state: {
          id: order.id,
          ownerId: order.ownerId,
          side: order.side,
          price: parsePrice(order.price),
          quantity: parseQuantity(order.quantity),
          remaining: parseQuantity(order.remainingQuantity),
          prioritySeq: rank(order, index),
        },
      },
    ]),
  );
  const toBookOrder = (order: Order) => byId.get(order.id)!.state;
  const fromBookOrder = (state: BookOrder): Order => ({
    ...byId.get(state.id)!.original,
    price: formatPrice(state.price),
    quantity: formatQuantity(state.quantity),
    remainingQuantity: formatQuantity(state.remaining),
    status: state.remaining === state.quantity ? 'open' : 'partially_filled',
  });

  const order = toBookOrder(incoming);
  const result = apply(
    { bids: book.bids.map(toBookOrder), asks: book.asks.map(toBookOrder) },
    {
      type: 'submit',
      instrument: incoming.instrument,
      seq: order.prioritySeq,
      acceptedAt: incoming.createdAt.toISOString(),
      order,
    },
  );
  const updatedBids = result.book.bids.map(fromBookOrder);
  const updatedAsks = result.book.asks.map(fromBookOrder);
  const restingOrder =
    (incoming.side === 'buy' ? updatedBids : updatedAsks).find(({ id }) => id === incoming.id) ??
    null;
  const cancelled = result.orderChanges.find(
    (change) => change.id === incoming.id && change.status === 'cancelled',
  );
  const trades = result.trades.map(({ tradeId, price, quantity, executedAt, ...fill }, index) => ({
    ...fill,
    // A legacy priority rank is local to a snapshot, so it cannot identify a fill.
    id: sequenced
      ? tradeId
      : uuidv5(
          UNSEQUENCED_TRADE_NAMESPACE,
          JSON.stringify([incoming.instrument, incoming.id, index]),
        ),
    price: formatPrice(price),
    quantity: formatQuantity(quantity),
    executedAt: new Date(executedAt),
  }));
  const match: MatchResult = { trades, restingOrder, updatedBids, updatedAsks };
  if (cancelled?.status === 'cancelled' && cancelled.cancelReason === 'self_trade_prevented') {
    match.cancelledIncoming = {
      ...fromBookOrder(cancelled),
      status: 'cancelled',
      cancelReason: cancelled.cancelReason,
    };
  }
  return match;
}
