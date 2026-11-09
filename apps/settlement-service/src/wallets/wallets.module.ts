import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsController } from './wallets.controller';
import { WalletPublisher } from './wallet-publisher';

@Module({
  imports: [
    LedgerModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [WalletsController],
  providers: [WalletPublisher],
  exports: [WalletPublisher],
})
export class WalletsModule {}
