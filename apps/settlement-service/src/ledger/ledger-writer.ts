import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
import type { SettlementEnv } from '../config/env.validation';
import { ASSET_SCALES, Asset, formatAmount } from './amount';
import { AccountRef, Posting, PostingBuilder, Wallet } from './posting-builder';

interface Account {
  id: string;
  balance: string;
  version: string;
}

interface JournalEntry {
  operationId: string;
  type: 'genesis' | 'reserve' | 'trade' | 'release';
  reservationId?: string;
  tradeId?: string;
  traceId?: string;
}

function key(ref: AccountRef): string {
  return `${ref.asset}:${ref.userId ?? ''}:${ref.kind}`;
}

function walletAccounts(wallet: Wallet): AccountRef[] {
  return [
    { ...wallet, kind: 'available' },
    { ...wallet, kind: 'reserved' },
  ];
}

export function requestHash(request: object): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export interface WalletBalance {
  userId: string;
  asset: Asset;
  available: string;
  reserved: string;
  version: string;
}

export class LockedAccounts {
  constructor(private readonly accounts: Map<string, Account>) {}

  get(ref: AccountRef): Account {
    const account = this.accounts.get(key(ref));
    if (!account) throw new Error('Ledger account is not locked');
    return account;
  }

  wallet({ userId, asset }: Wallet): WalletBalance {
    const available = this.get({ userId, asset, kind: 'available' });
    const reserved = this.get({ userId, asset, kind: 'reserved' });
    return {
      userId,
      asset,
      available: formatAmount(BigInt(available.balance), ASSET_SCALES[asset]),
      reserved: formatAmount(BigInt(reserved.balance), ASSET_SCALES[asset]),
      version: (BigInt(available.version) + BigInt(reserved.version)).toString(),
    };
  }
}

@Injectable()
export class LedgerWriter {
  constructor(private readonly config: ConfigService<SettlementEnv, true>) {}

  async lockWallets(db: EntityManager, wallets: Wallet[]): Promise<LockedAccounts> {
    const refs = new Map<string, AccountRef>();
    for (const wallet of wallets) {
      for (const account of walletAccounts(wallet)) refs.set(key(account), account);
    }
    const ids = new Map<string, string>();
    const genesis: { wallet: Wallet; amount: bigint }[] = [];
    const amounts = this.config.getOrThrow('DEMO_INITIAL_BALANCES', { infer: true });

    // Вставки й блокування мають два фіксовані порядки, спільні для всіх операцій.
    for (const accountKey of [...refs.keys()].sort()) {
      const account = refs.get(accountKey)!;
      const { id, created } = await this.ensureAccount(db, account);
      ids.set(accountKey, id);
      if (created && account.kind === 'available' && amounts[account.asset] > 0n) {
        genesis.push({
          wallet: { userId: account.userId!, asset: account.asset },
          amount: amounts[account.asset],
        });
      }
    }
    for (const asset of [...new Set(genesis.map(({ wallet }) => wallet.asset))].sort()) {
      const ref: AccountRef = { userId: null, asset, kind: 'genesis' };
      ids.set(key(ref), (await this.ensureAccount(db, ref)).id);
    }

    const rows: Account[] = await db.query(
      'SELECT id, balance, version FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
      [[...ids.values()]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const locked = new LockedAccounts(new Map([...ids].map(([ref, id]) => [ref, byId.get(id)!])));
    for (const { wallet, amount } of genesis) {
      await this.write(
        db,
        locked,
        { operationId: `genesis:${wallet.userId}:${wallet.asset}`, type: 'genesis' },
        PostingBuilder.transfer('genesis', wallet, amount),
      );
    }
    return locked;
  }

  private async ensureAccount(db: EntityManager, { userId, asset, kind }: AccountRef) {
    const [inserted]: { id: string }[] = await db.query(
      `INSERT INTO accounts (user_id, asset, kind) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, asset, kind) DO NOTHING RETURNING id`,
      [userId, asset, kind],
    );
    if (inserted) return { id: inserted.id, created: true };
    const [existing]: { id: string }[] =
      userId === null
        ? await db.query(
            "SELECT id FROM accounts WHERE user_id IS NULL AND asset=$1 AND kind='genesis'",
            [asset],
          )
        : await db.query('SELECT id FROM accounts WHERE user_id=$1 AND asset=$2 AND kind=$3', [
            userId,
            asset,
            kind,
          ]);
    return { id: existing.id, created: false };
  }

  async write(
    db: EntityManager,
    accounts: LockedAccounts,
    entry: JournalEntry,
    postings: Posting[],
  ): Promise<string> {
    PostingBuilder.balanced(postings);
    const [{ id }]: { id: string }[] = await db.query(
      `INSERT INTO journal_entries (operation_id, type, reservation_id, trade_id, trace_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [entry.operationId, entry.type, entry.reservationId, entry.tradeId, entry.traceId],
    );
    const deltas = new Map<Account, bigint>();
    for (const posting of postings) {
      const account = accounts.get(posting);
      const amount = posting.amount;
      const delta = posting.direction === 'credit' ? amount : -amount;
      deltas.set(account, (deltas.get(account) ?? 0n) + delta);
      await db.query(
        'INSERT INTO postings (entry_id, account_id, asset, direction, amount) VALUES ($1, $2, $3, $4, $5)',
        [id, account.id, posting.asset, posting.direction, amount.toString()],
      );
    }
    for (const [account, delta] of deltas) {
      await db.query('UPDATE accounts SET balance=balance+$2, version=version+1 WHERE id=$1', [
        account.id,
        delta.toString(),
      ]);
      account.balance = (BigInt(account.balance) + delta).toString();
      account.version = (BigInt(account.version) + 1n).toString();
    }
    return id;
  }
}
