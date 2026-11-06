import { createHash } from 'node:crypto';

type Side = 'buy' | 'sell';
type Status = 'open' | 'partially_filled' | 'filled' | 'cancelled';

export interface ReferenceOrder {
  id: string;
  ownerId: string;
  side: Side;
  price: bigint;
  quantity: bigint;
  remaining: bigint;
  prioritySeq: bigint;
}

interface Entry extends ReferenceOrder {
  status: Status;
}

type ReferenceCommand =
  | {
    type: 'submit';
    instrument: string;
    seq: bigint;
    acceptedAt: string;
    order: Omit<ReferenceOrder, 'prioritySeq'>;
  }
  | { type: 'cancel'; orderId: string };

interface Trade {
  tradeId: string;
  instrument: string;
  buyOrderId: string;
  sellOrderId: string;
  price: bigint;
  quantity: bigint;
  executedAt: string;
}

const active = (entry: Entry) => entry.status === 'open' || entry.status === 'partially_filled';

function tradeId(name: string): string {
  const namespace = Buffer.from('f9e78716da87438a9f3b597adb11b678', 'hex');
  const input = Buffer.concat([namespace, Buffer.from(name)]);
  const hash = createHash('sha1').update(input).digest('hex');
  const variant = '89ab'[parseInt(hash[16], 16) % 4];
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function bestFirst(a: ReferenceOrder, b: ReferenceOrder): number {
  const priceOrder = a.side === 'sell' ? a.price - b.price : b.price - a.price;
  const order = priceOrder === 0n ? a.prioritySeq - b.prioritySeq : priceOrder;
  return order < 0n ? -1 : order > 0n ? 1 : 0;
}

export class ReferenceMatcher {
  readonly orders = new Map<string, Entry>();

  constructor(resting: readonly ReferenceOrder[] = []) {
    for (const order of resting) {
      this.orders.set(order.id, {
        ...order,
        status: order.remaining === order.quantity ? 'open' : 'partially_filled',
      });
    }
  }

  book(): { bids: ReferenceOrder[]; asks: ReferenceOrder[] } {
    const bids: ReferenceOrder[] = [];
    const asks: ReferenceOrder[] = [];
    for (const entry of this.orders.values()) {
      if (active(entry)) {
        const { id, ownerId, side, price, quantity, remaining, prioritySeq } = entry;
        (side === 'buy' ? bids : asks).push({ id, ownerId, side, price, quantity, remaining, prioritySeq });
      }
    }
    return { bids: bids.sort(bestFirst), asks: asks.sort(bestFirst) };
  }

  apply(command: ReferenceCommand): { trades: Trade[]; outcome: string } {
    if (command.type === 'cancel') {
      const entry = this.orders.get(command.orderId);
      if (!entry) return { trades: [], outcome: 'not_found' };
      if (!active(entry)) return { trades: [], outcome: `already_${entry.status}` };
      entry.status = 'cancelled';
      return { trades: [], outcome: 'applied' };
    }

    const incoming: Entry = { ...command.order, prioritySeq: command.seq, status: 'open' };
    const trades: Trade[] = [];
    while (incoming.remaining > 0n) {
      let maker: Entry | undefined;
      // Search the full set again for each fill, independently of the active book layout.
      for (const order of this.orders.values()) {
        if (!active(order) || order.side === incoming.side) continue;
        const eligible = order.side === 'sell' ? order.price <= incoming.price : order.price >= incoming.price;
        if (eligible && (!maker || bestFirst(order, maker) < 0)) maker = order;
      }
      if (!maker) break;
      if (maker.ownerId === incoming.ownerId) {
        incoming.status = 'cancelled';
        break;
      }

      const amount = maker.remaining > incoming.remaining ? incoming.remaining : maker.remaining;
      maker.remaining -= amount;
      incoming.remaining -= amount;
      maker.status = maker.remaining === 0n ? 'filled' : 'partially_filled';
      const [buy, sell] = maker.side === 'buy' ? [maker, incoming] : [incoming, maker];
      trades.push({
        tradeId: tradeId(`${command.instrument}:${command.seq}:${trades.length}`),
        instrument: command.instrument,
        buyOrderId: buy.id,
        sellOrderId: sell.id,
        price: maker.price,
        quantity: amount,
        executedAt: command.acceptedAt,
      });
    }

    if (incoming.status !== 'cancelled') {
      if (incoming.remaining === 0n) incoming.status = 'filled';
      else if (incoming.remaining < incoming.quantity) incoming.status = 'partially_filled';
    }
    this.orders.set(incoming.id, incoming);
    return { trades, outcome: 'applied' };
  }
}
