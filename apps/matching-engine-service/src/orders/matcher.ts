import { randomUUID } from 'crypto';
import { Order } from './entities/order.entity';
import { BookSnapshot, MatchResult, Trade } from './order-book.types';

/**
 * Чиста функція зіставлення заявки з наявною книгою (price-time priority).
 * Не звертається до жодного зовнішнього стану — приймає знімок книги,
 * повертає результат. Побічні ефекти (запис у реальну книгу, персистенція)
 * — відповідальність викликача.
 */
export function matchOrder(book: BookSnapshot, incoming: Order): MatchResult {
  const trades: Trade[] = [];
  const rawOpposite = incoming.side === 'buy' ? [...book.asks] : [...book.bids];
  const oppositeSide: Order['side'] = incoming.side === 'buy' ? 'sell' : 'buy';
  // Явно впорядковуємо протилежну сторону за price-time priority перед
  // матчингом — не покладаємось на те, що виклик передав уже відсортований
  // знімок книги.
  const opposite = sortByPriceTimePriority(rawOpposite, oppositeSide);
  const remainingOpposite: Order[] = [];

  let remainingQty = Number(incoming.remainingQuantity);

  for (const resting of opposite) {
    const priceCrosses =
      incoming.side === 'buy'
        ? Number(incoming.price) >= Number(resting.price)
        : Number(incoming.price) <= Number(resting.price);

    // Self-trade prevention: заявки одного власника не зіставляються.
    const sameOwner = resting.ownerId === incoming.ownerId;

    if (remainingQty > 0 && priceCrosses && !sameOwner) {
      const tradeQty = Math.min(remainingQty, Number(resting.remainingQuantity));
      trades.push({
        id: randomUUID(),
        instrument: incoming.instrument,
        buyOrderId: incoming.side === 'buy' ? incoming.id : resting.id,
        sellOrderId: incoming.side === 'buy' ? resting.id : incoming.id,
        price: resting.price, // виконання за ціною заявки, що вже стояла в книзі
        quantity: tradeQty.toFixed(8),
        executedAt: new Date(),
      });

      remainingQty = Number((remainingQty - tradeQty).toFixed(8));
      const restingRemainder = Number(
        (Number(resting.remainingQuantity) - tradeQty).toFixed(8),
      );

      if (restingRemainder > 0) {
        remainingOpposite.push({
          ...resting,
          remainingQuantity: restingRemainder.toFixed(8),
          status: 'partially_filled',
        });
      }
      // якщо restingRemainder === 0 — заявка повністю виконана, у книгу не повертається
    } else {
      remainingOpposite.push(resting);
    }
  }

  const restingOrder: Order | null =
    remainingQty > 0
      ? {
          ...incoming,
          remainingQuantity: remainingQty.toFixed(8),
          status: remainingQty < Number(incoming.quantity) ? 'partially_filled' : 'open',
        }
      : null;

  const same = incoming.side === 'buy' ? book.bids : book.asks;
  const updatedSame = restingOrder ? insertByPriceTimePriority(same, restingOrder) : same;

  return {
    trades,
    restingOrder,
    updatedBids: incoming.side === 'buy' ? updatedSame : remainingOpposite,
    updatedAsks: incoming.side === 'buy' ? remainingOpposite : updatedSame,
  };
}

function insertByPriceTimePriority(list: Order[], order: Order): Order[] {
  return sortByPriceTimePriority([...list, order], order.side);
}

function sortByPriceTimePriority(list: Order[], side: Order['side']): Order[] {
  const result = [...list];
  result.sort((a, b) => {
    const priceDiff =
      side === 'buy'
        ? Number(b.price) - Number(a.price) // bids: спадання ціни
        : Number(a.price) - Number(b.price); // asks: зростання ціни
    if (priceDiff !== 0) return priceDiff;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return result;
}
