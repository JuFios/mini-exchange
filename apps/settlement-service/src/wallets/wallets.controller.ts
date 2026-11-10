import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ASSETS } from '../ledger/amount';
import { LedgerWriter } from '../ledger/ledger-writer';
import { WalletAccessGuard, WalletRequest } from '../security/wallet-access.guard';

class WalletQuery {}

@Controller('wallets')
@UseGuards(WalletAccessGuard)
export class WalletsController {
  constructor(
    private readonly source: DataSource,
    private readonly ledger: LedgerWriter,
  ) {}

  @Get()
  async list(@Req() request: WalletRequest, @Query() _query: WalletQuery) {
    const wallets = ASSETS.map((asset) => ({ asset, userId: request.walletUserId }));
    return this.source.transaction(async (db) => {
      const accounts = await this.ledger.lockWallets(db, wallets);
      return wallets.map((wallet) => {
        // `version` та сама, що в `wallet.updated`: за нею клієнт відкидає запізнілі події.
        const { asset, available, reserved, version } = accounts.wallet(wallet);
        return { asset, available, reserved, version };
      });
    });
  }
}
