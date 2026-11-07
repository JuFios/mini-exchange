import { Order } from '../orders/entities/order.entity';
import { BookOrder } from '../matching/book';
import { parsePrice, parseQuantity } from '../matching/decimal';

export interface CommandRow {
  instrument: string;
  seq: string;
  type: 'submit' | 'cancel';
  order_id: string;
  user_id: string;
  payload: { side: 'buy' | 'sell'; price: string; quantity: string };
  traceparent: string | null;
  accepted_at: Date;
}

export function bookOrder(order: Order): BookOrder {
  return {
    id: order.id, ownerId: order.ownerId, side: order.side,
    price: parsePrice(order.price), quantity: parseQuantity(order.quantity),
    remaining: order.remainingQuantity === '0.00000000' ? 0n : parseQuantity(order.remainingQuantity),
    prioritySeq: BigInt(order.prioritySeq!),
  };
}
