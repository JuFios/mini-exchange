import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { OrderBookService } from '../orders/order-book.service';
import { compareOrders } from '../matching/book';
import { parsePrice, parseQuantity } from '../matching/decimal';

@Injectable()
export class BookLoader implements OnModuleInit {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly books: OrderBookService,
  ) {}

  async onModuleInit(): Promise<void> {
    const orders = await this.orders.find({ where: { status: In(['open', 'partially_filled']) } });
    const symbols = new Set(orders.map(({ instrument }) => instrument));
    for (const symbol of symbols) {
      const sorted = orders.filter(({ instrument }) => instrument === symbol).sort((a, b) => a.side !== b.side ? a.side.localeCompare(b.side) : compareOrders(
        { ...a, price: parsePrice(a.price), quantity: parseQuantity(a.quantity), remaining: parseQuantity(a.remainingQuantity), prioritySeq: BigInt(a.prioritySeq ?? a.createdAt.getTime()) },
        { ...b, price: parsePrice(b.price), quantity: parseQuantity(b.quantity), remaining: parseQuantity(b.remainingQuantity), prioritySeq: BigInt(b.prioritySeq ?? b.createdAt.getTime()) },
      ));
      this.books.replace(symbol, {
        bids: sorted.filter(({ side }) => side === 'buy'),
        asks: sorted.filter(({ side }) => side === 'sell'),
      });
    }
  }
}
