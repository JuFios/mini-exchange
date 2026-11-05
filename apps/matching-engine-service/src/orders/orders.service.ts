import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Order } from './entities/order.entity';
import { OrderBookService } from './order-book.service';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { matchOrder } from './matcher';
import { Trade } from './order-book.types';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly orderBook: OrderBookService,
  ) {}

  async submitOrder(dto: SubmitOrderDto, ownerId: string): Promise<Trade[]> {
    const incoming: Order = {
      id: randomUUID(),
      ownerId,
      instrument: dto.instrument,
      side: dto.side,
      price: dto.price.toFixed(2),
      quantity: dto.quantity.toFixed(8),
      remainingQuantity: dto.quantity.toFixed(8),
      status: 'open',
      createdAt: new Date(),
    };

    const book = this.orderBook.snapshot(dto.instrument);
    const result = matchOrder(book, incoming);

    // Персистенція заявки в БД перед оновленням книги. Це асинхронна
    // операція — під час await виконання переходить іншим таскам у черзі
    // подій Node.js (наприклад, паралельному виклику submitOrder для
    // того самого інструмента).
    await this.orders.save(
      this.orders.create({
        ...incoming,
        remainingQuantity: result.restingOrder
          ? result.restingOrder.remainingQuantity
          : '0',
        status: result.restingOrder ? result.restingOrder.status : 'filled',
      }),
    );

    // Застосовуємо результат зіставлення (обчислений зі знімку книги,
    // знятого до await вище) до поточного стану книги інструмента.
    this.orderBook.replace(dto.instrument, {
      bids: result.updatedBids,
      asks: result.updatedAsks,
    });

    // TODO: опублікувати result.trades у чергу подій для settlement-service
    // (наприклад, Redis Streams / Kafka, партиційовано за instrument).
    // Поки що угоди лише повертаються викликачу й нікуди не публікуються.

    return result.trades;
  }

  async cancelOrder(orderId: string, instrument: string): Promise<void> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('Заявку не знайдено');
    }
    order.status = 'cancelled';
    order.remainingQuantity = '0';
    await this.orders.save(order);
    this.orderBook.removeOrder(instrument, orderId);
  }

  async listOwn(ownerId: string): Promise<Order[]> {
    return this.orders.find({ where: { ownerId } });
  }

  getDepth(instrument: string) {
    return this.orderBook.depth(instrument);
  }
}
