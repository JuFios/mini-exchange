import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { DecimalError, formatPrice, formatQuantity, parsePrice, parseQuantity } from '../matching/decimal';
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
    // Ті самі повідомлення й форма (масив), що й у DTO для рядкових сум.
    const price = this.amount(() => formatPrice(parsePrice(dto.price)), 'Некоректна ціна');
    const quantity = this.amount(() => formatQuantity(parseQuantity(dto.quantity)), 'Некоректна кількість');

    const incoming: Order = {
      id: randomUUID(),
      ownerId,
      instrument: dto.instrument,
      side: dto.side,
      price,
      quantity,
      remainingQuantity: quantity,
      status: 'open',
      createdAt: new Date(),
    };

    const book = this.orderBook.snapshot(dto.instrument);
    const result = matchOrder(book, incoming);

    // Персистенція заявки в БД перед оновленням книги. Це асинхронна
    // операція — під час await виконання переходить іншим таскам у черзі
    // подій Node.js (наприклад, паралельному виклику submitOrder для
    // того самого інструмента).
    // Скасований залишок зберігаємо як є: різниця quantity і remainingQuantity
    // показує, скільки вже виконано до скасування.
    const settled = result.cancelledIncoming ?? result.restingOrder;
    await this.orders.save(
      this.orders.create({
        ...incoming,
        remainingQuantity: settled?.remainingQuantity ?? '0',
        status: settled?.status ?? 'filled',
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

  private amount(read: () => string, message: string): string {
    try {
      return read();
    } catch (error) {
      if (error instanceof DecimalError) throw new BadRequestException([message]);
      throw error;
    }
  }

  async cancelOrder(orderId: string, userId: string, instrumentHint?: string): Promise<void> {
    const order = await this.orders.findOne({ where: { id: orderId, ownerId: userId } });
    if (!order) {
      throw new NotFoundException('Заявку не знайдено');
    }
    if (instrumentHint !== undefined && instrumentHint !== order.instrument) {
      throw new BadRequestException('Інструмент не збігається з інструментом заявки');
    }
    if (order.status !== 'open' && order.status !== 'partially_filled') {
      throw new ConflictException('Заявку вже закрито');
    }
    const { affected } = await this.orders.update(
      { id: order.id, ownerId: userId, status: order.status },
      { status: 'cancelled', remainingQuantity: '0' },
    );
    if (affected !== 1) {
      throw new ConflictException('Стан заявки змінився');
    }
    this.orderBook.removeOrder(order.instrument, order.id);
  }

  async listOwn(ownerId: string): Promise<Order[]> {
    return this.orders.find({ where: { ownerId } });
  }
}
