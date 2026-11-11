import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ASSETS } from '../ledger/amount';
import { LedgerWriter, WalletBalance } from '../ledger/ledger-writer';
import { WalletReader } from '../ledger/wallet-reader';
import { WalletAccessGuard, WalletRequest } from '../security/wallet-access.guard';

class WalletQuery {}

// `version` та сама, що в `wallet.updated`: за нею клієнт відкидає запізнілі події.
const project = ({ asset, available, reserved, version }: WalletBalance) => ({
  asset,
  available,
  reserved,
  version,
});

@Controller('wallets')
@UseGuards(WalletAccessGuard)
export class WalletsController {
  constructor(
    private readonly source: DataSource,
    private readonly ledger: LedgerWriter,
    private readonly reader: WalletReader,
  ) {}

  @Get()
  async list(@Req() request: WalletRequest, @Query() _query: WalletQuery) {
    const wallets = ASSETS.map((asset) => ({ asset, userId: request.walletUserId }));
    // Читання без блокувань не чекає на розрахунок, що тримає ці рахунки.
    const balances = await this.reader.read(wallets);
    if (balances.length === wallets.length) return balances.map(project);
    // Перше звернення: рахунки й демо-баланси створює той самий шлях, що й розрахунок.
    return this.source.transaction(async (db) => {
      const accounts = await this.ledger.lockWallets(db, wallets);
      return wallets.map((wallet) => project(accounts.wallet(wallet)));
    });
  }
}
