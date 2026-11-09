import type { Asset } from './amount';

export interface Wallet {
  userId: string;
  asset: Asset;
}

export interface AccountRef {
  userId: string | null;
  asset: Asset;
  kind: 'available' | 'reserved' | 'genesis';
}

export interface Posting extends AccountRef {
  direction: 'debit' | 'credit';
  amount: bigint;
}

type PostingType = 'genesis' | 'reserve' | 'release';

export class PostingBuilder {
  static transfer(type: PostingType, wallet: Wallet, amount: bigint): Posting[] {
    const source: AccountRef =
      type === 'genesis'
        ? { userId: null, asset: wallet.asset, kind: 'genesis' }
        : { ...wallet, kind: type === 'reserve' ? 'available' : 'reserved' };
    return this.balanced([
      { ...source, direction: 'debit', amount },
      {
        ...wallet,
        kind: type === 'reserve' ? 'reserved' : 'available',
        direction: 'credit',
        amount,
      },
    ]);
  }

  static trade(input: {
    buyerUserId: string;
    sellerUserId: string;
    baseAsset: Asset;
    quoteAsset: Asset;
    price: bigint;
    quantity: bigint;
    buyLimit: bigint;
  }): Posting[] {
    const { buyerUserId, sellerUserId, baseAsset, quoteAsset, price, quantity, buyLimit } = input;
    if (price <= 0n || quantity <= 0n || buyLimit < price) throw new Error('Invalid trade amounts');
    const refund = (buyLimit - price) * quantity;
    const postings: Posting[] = [
      {
        userId: sellerUserId,
        asset: baseAsset,
        kind: 'reserved',
        direction: 'debit',
        amount: quantity,
      },
      {
        userId: buyerUserId,
        asset: baseAsset,
        kind: 'available',
        direction: 'credit',
        amount: quantity,
      },
      {
        userId: buyerUserId,
        asset: quoteAsset,
        kind: 'reserved',
        direction: 'debit',
        amount: buyLimit * quantity,
      },
      {
        userId: sellerUserId,
        asset: quoteAsset,
        kind: 'available',
        direction: 'credit',
        amount: price * quantity,
      },
    ];
    if (refund > 0n) {
      postings.push({
        userId: buyerUserId,
        asset: quoteAsset,
        kind: 'available',
        direction: 'credit',
        amount: refund,
      });
    }
    return this.balanced(postings);
  }

  static balanced(postings: Posting[]): Posting[] {
    const totals = new Map<Asset, bigint>();
    for (const posting of postings) {
      if (posting.amount <= 0n) throw new Error('Posting amount must be positive');
      const delta = posting.direction === 'credit' ? posting.amount : -posting.amount;
      totals.set(posting.asset, (totals.get(posting.asset) ?? 0n) + delta);
    }
    if (!postings.length || [...totals.values()].some((total) => total !== 0n))
      throw new Error('Unbalanced postings');
    return postings;
  }
}
