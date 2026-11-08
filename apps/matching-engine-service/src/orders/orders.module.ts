import { CommittedBook } from '../engine/committed-book';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CommandApplier } from '../engine/command-applier';
import { InstrumentWorker } from '../engine/instrument-worker';
import { LeaseManager } from '../ownership/lease-manager';
import { OwnershipCoordinator } from '../ownership/ownership-coordinator';
import { AdminInstrumentsController } from '../ownership/admin-instruments.controller';
import { ReadinessController } from '../ownership/readiness.controller';
import { ChaosHooks } from '../chaos/chaos-hooks';
import { ChaosController } from '../chaos/chaos.controller';
import { PgNotifications } from '../engine/pg-notifications';
import { IntakeService } from '../intake/intake.service';
import { NoopReservationClient, ReservationClient } from '../intake/reservation.client';
import { BookLoader } from '../engine/book-loader';
import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderBookService } from './order-book.service';
import { OrdersGateway } from './gateway/orders.gateway';
import { Order } from './entities/order.entity';
import { Instrument } from './entities/instrument.entity';
import { MarketController } from './market.controller';
import { InstrumentCatalog } from './instrument-catalog';

@Module({
  imports: [TypeOrmModule.forFeature([Order, Instrument])],
  controllers: [
    MarketController,
    OrdersController,
    AdminInstrumentsController,
    ReadinessController,
  ],
  providers: [
    CommittedBook,
    CommandApplier,
    InstrumentWorker,
    OwnershipCoordinator,
    LeaseManager,
    ChaosHooks,
    PgNotifications,
    IntakeService,
    {
      provide: ReservationClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.getOrThrow('RESERVATIONS_ENABLED'))
          throw new Error('RESERVATIONS_ENABLED requires an HTTP reservation client');
        return new NoopReservationClient();
      },
    },
    BookLoader,
    OrdersService,
    OrderBookService,
    OrdersGateway,
    InstrumentCatalog,
  ],
  exports: [OrderBookService],
})
export class OrdersModule {
  static async register(): Promise<DynamicModule> {
    await ConfigModule.envVariablesLoaded;
    return {
      module: OrdersModule,
      controllers: process.env.CHAOS_ENABLED === 'true' ? [ChaosController] : [],
    };
  }
}
