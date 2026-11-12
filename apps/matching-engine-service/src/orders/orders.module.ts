import { RateLimitModule } from '../security/rate-limit.module';
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
import { HttpReservationClient } from '../intake/http-reservation.client';
import { ReservationFundingCheck } from '../intake/reservation-funding.check';
import { ReservationSweeper } from '../intake/reservation-sweeper';
import { InternalOrdersController } from '../outbox/internal-orders.controller';
import { InternalTradesController } from '../outbox/internal-trades.controller';
import { OutboxRedriveController } from '../outbox/outbox-redrive.controller';
import { IntakeService } from '../intake/intake.service';
import { NoopReservationClient, ReservationClient } from '../intake/reservation.client';
import { BookLoader } from '../engine/book-loader';
import { MarketGateway } from '../realtime/market.gateway';
import { PrivateGateway } from '../realtime/private.gateway';
import { RealtimeStreamReader } from '../realtime/realtime-stream-reader.service';
import { ReplicaLagMonitor } from '../realtime/replica-lag.monitor';
import { DynamicModule, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersGateway } from './gateway/orders.gateway';
import { Order } from './entities/order.entity';
import { Instrument } from './entities/instrument.entity';
import { MarketController } from './market.controller';
import { InstrumentCatalog } from './instrument-catalog';
import { AuthModule } from '../auth/auth.module';
import { TerminusModule } from '@nestjs/terminus';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Instrument]),
    JwtModule.register({}),
    AuthModule,
    RateLimitModule,
    TerminusModule,
  ],
  controllers: [
    MarketController,
    OrdersController,
    AdminInstrumentsController,
    ReadinessController,
    InternalTradesController,
    InternalOrdersController,
    OutboxRedriveController,
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
    ReservationSweeper,
    ReservationFundingCheck,
    {
      provide: ReservationClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return config.getOrThrow('RESERVATIONS_ENABLED')
          ? new HttpReservationClient(config)
          : new NoopReservationClient();
      },
    },
    BookLoader,
    OrdersService,
    OrdersGateway,
    RealtimeStreamReader,
    ReplicaLagMonitor,
    MarketGateway,
    PrivateGateway,
    InstrumentCatalog,
  ],
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
