import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { engineDataSourceOptions } from './data-source';
import { HealthController } from './health.controller';
import { EngineEnv, validateEnv } from './config/env.validation';
import { OutboxRelay } from './outbox/outbox-relay.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
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
  providers: [OutboxRelay],
})
export class AppModule {}
