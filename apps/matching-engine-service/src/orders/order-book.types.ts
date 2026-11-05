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

export interface MatchResult {
  trades: Trade[];
  restingOrder: Order | null; // залишок заявки, що лягає в книгу (якщо є)
  updatedBids: Order[];
  updatedAsks: Order[];
}
