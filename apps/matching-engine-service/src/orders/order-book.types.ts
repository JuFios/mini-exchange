import { Order } from './entities/order.entity';

export interface Trade {
  id: string;
  instrument: string;
  buyOrderId: string;
  sellOrderId: string;
  price: string;
  quantity: string;
  executedAt: Date;
}

export interface BookSnapshot {
  bids: Order[]; // сортовані: ціна спадає, за рівної ціни — час зростає
  asks: Order[]; // сортовані: ціна зростає, за рівної ціни — час зростає
}

export const DEFAULT_BOOK_DEPTH = 50;
export const MAX_BOOK_DEPTH = 50;

export interface BookLevel {
  price: string;
  quantity: string;
  orders: number;
}

export interface BookDepth {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface MatchResult {
  trades: Trade[];
  restingOrder: Order | null; // залишок заявки, що лягає в книгу (якщо є)
  updatedBids: Order[];
  updatedAsks: Order[];
  cancelledIncoming?: Order & { status: 'cancelled'; cancelReason: 'self_trade_prevented' };
}
