import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ASSET_SCALES, Asset, formatAmount } from './amount';
import type { WalletBalance } from './ledger-writer';
import type { Wallet } from './posting-builder';

interface AccountRow {
  user_id: string;
  asset: Asset;
  kind: 'available' | 'reserved';
  balance: string;
  version: string;
}

@Injectable()
export class WalletReader {
  constructor(private readonly source: DataSource) {}

  /** Читає поточний стан без блокувань; гаманці, яких ще немає в ledger, пропускає. */
  async read(wallets: Wallet[]): Promise<WalletBalance[]> {
    const rows: AccountRow[] = await this.source.query(
      `SELECT a.user_id, a.asset, a.kind, a.balance, a.version
       FROM accounts a JOIN unnest($1::uuid[], $2::text[]) AS w(user_id, asset)
         ON a.user_id = w.user_id AND a.asset = w.asset
       WHERE a.kind IN ('available', 'reserved')`,
      [wallets.map(({ userId }) => userId), wallets.map(({ asset }) => asset)],
    );
    return wallets.flatMap(({ userId, asset }) => {
      const available = rows.find(
        (r) => r.user_id === userId && r.asset === asset && r.kind === 'available',
      );
      const reserved = rows.find(
        (r) => r.user_id === userId && r.asset === asset && r.kind === 'reserved',
      );
      if (!available || !reserved) return [];
      const scale = ASSET_SCALES[asset];
      return [
        {
          userId,
          asset,
          available: formatAmount(BigInt(available.balance), scale),
          reserved: formatAmount(BigInt(reserved.balance), scale),
          version: (BigInt(available.version) + BigInt(reserved.version)).toString(),
        },
      ];
    });
  }
}
