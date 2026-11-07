import { ConfigService } from '@nestjs/config';
import { CommandApplier } from '../engine/command-applier';
import { InstrumentWorker } from '../engine/instrument-worker';
import { LocalOwnership } from '../engine/local-ownership';
import { PgNotifications } from '../engine/pg-notifications';
import { IntakeService } from '../intake/intake.service';
import { NoopReservationClient, ReservationClient } from '../intake/reservation.client';
import { BookLoader } from '../engine/book-loader';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderBookService } from './order-book.service';
import { OrdersGateway } from './gateway/orders.gateway';
import { Order } from './entities/order.entity';
import { Instrument } from './entities/instrument.entity';
import { MarketController } from './market.controller';
import { InstrumentCatalog } from './instrument-catalog';
import { RedisLockService } from '../locks/redis-lock.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, Instrument])],
  controllers: [MarketController, OrdersController],
  providers: [
    CommandApplier, InstrumentWorker, LocalOwnership, PgNotifications, IntakeService,
    { provide: ReservationClient, inject: [ConfigService], useFactory: (config: ConfigService) => {
      if (config.getOrThrow('RESERVATIONS_ENABLED')) throw new Error('RESERVATIONS_ENABLED requires an HTTP reservation client');
      return new NoopReservationClient();
    } },
    BookLoader, OrdersService, OrderBookService, OrdersGateway, RedisLockService, InstrumentCatalog],
  exports: [OrderBookService],
})
export class OrdersModule {}
