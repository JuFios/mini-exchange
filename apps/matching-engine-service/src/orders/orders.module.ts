import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderBookService } from './order-book.service';
import { OrdersGateway } from './gateway/orders.gateway';
import { Order } from './entities/order.entity';
import { MarketController } from './market.controller';
import { RedisLockService } from '../locks/redis-lock.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order])],
  controllers: [MarketController, OrdersController],
  providers: [OrdersService, OrderBookService, OrdersGateway, RedisLockService],
  exports: [OrderBookService],
})
export class OrdersModule {}
