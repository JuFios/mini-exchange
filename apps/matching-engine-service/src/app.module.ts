import { LoggingModule } from './observability/logging';
import { TerminusModule } from '@nestjs/terminus';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { engineDataSourceOptions } from './data-source';
import { HealthController } from './health.controller';
import { EngineEnv, validateEnv } from './config/env.validation';
import { OutboxRelay } from './outbox/outbox-relay.service';
import { ReservationFundingCheck } from './intake/reservation-funding.check';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggingModule,
    TerminusModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EngineEnv, true>) =>
        engineDataSourceOptions({
          DATABASE_HOST: config.getOrThrow('DATABASE_HOST', { infer: true }),
          DATABASE_PORT: config.getOrThrow('DATABASE_PORT', { infer: true }),
          DATABASE_USER: config.getOrThrow('DATABASE_USER', { infer: true }),
          DATABASE_PASSWORD: config.getOrThrow('DATABASE_PASSWORD', { infer: true }),
          DATABASE_NAME: config.getOrThrow('DATABASE_NAME', { infer: true }),
        }),
    }),
    AuthModule,
    OrdersModule.register(),
  ],
  controllers: [HealthController],
  providers: [OutboxRelay, ReservationFundingCheck],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly funding: ReservationFundingCheck) {}

  async onModuleInit(): Promise<void> {
    // Імпортовані модулі вже перевірили каталог і admin credentials. Worker стартує пізніше.
    await this.funding.ensureMode();
  }
}
