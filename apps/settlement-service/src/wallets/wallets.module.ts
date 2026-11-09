import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { SecurityModule } from '../security/security.module';
import { WalletsController } from './wallets.controller';
import { WalletPublisher } from './wallet-publisher';

@Module({
  imports: [LedgerModule, SecurityModule],
  controllers: [WalletsController],
  providers: [WalletPublisher],
  exports: [WalletPublisher],
})
export class WalletsModule {}
