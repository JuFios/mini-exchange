import { createHash } from 'node:crypto';
import { Book, BookOrder, changedLevels, compareOrders, LevelChange } from './book';
import { cancelNewest, StpPolicy } from './stp';

export const TRADE_ID_NAMESPACE = 'f9e78716-da87-438a-9f3b-597adb11b678';

export function uuidv5(namespace: string, name: string): string {
  if (
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(namespace) ||
    namespace.length !== 36
  ) {
    throw new Error('Invalid UUID namespace');
  }
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SubmitCommand {
  readonly type: 'submit';
  readonly instrument: string;
  readonly seq: bigint;
  readonly acceptedAt: string;
  readonly order: Omit<BookOrder, 'prioritySeq'>;
}

export interface CancelCommand {
  readonly type: 'cancel';
  readonly orderId: string;
  // Віддаємо збережений термінальний статус, коли заявки вже немає в активній книзі.
  readonly terminalStatus?: 'filled' | 'cancelled';
}

export type Command = SubmitCommand | CancelCommand;
type CancelReason = 'user' | 'self_trade_prevented';

export type OrderChange = BookOrder &
  (
    | { status: 'open' | 'partially_filled' | 'filled' }
    | { status: 'cancelled'; cancelReason: CancelReason }
  );

export interface Fill {
  tradeId: string;
  instrument: string;
  buyOrderId: string;
  sellOrderId: string;
  price: bigint;
  quantity: bigint;
  executedAt: string;
}

interface ClosedOrder {
  orderId: string;
  reason: CancelReason;
  // Одиниці котирування для buy, базові лоти для sell.
  releasedAmount: bigint;
}

export interface ApplyResult {
  book: Book;
  outcome: 'applied' | 'not_found' | 'already_filled' | 'already_cancelled';
  orderChanges: OrderChange[];
  trades: Fill[];
  levelChanges: LevelChange[];
  closed: ClosedOrder[];
}

function orderStatus({ remaining, quantity }: BookOrder): 'open' | 'partially_filled' | 'filled' {
  if (remaining === 0n) return 'filled';
  return remaining < quantity ? 'partially_filled' : 'open';
}

function close(order: BookOrder, reason: CancelReason): ClosedOrder {
  return {
    orderId: order.id,
    reason,
    releasedAmount: order.side === 'buy' ? order.price * order.remaining : order.remaining,
  };
}

function cancel(book: Book, command: CancelCommand): ApplyResult {
  const order =
    book.bids.find(({ id }) => id === command.orderId) ??
    book.asks.find(({ id }) => id === command.orderId);
  if (!order) {
    return {
      book,
      outcome: command.terminalStatus ? `already_${command.terminalStatus}` : 'not_found',
      orderChanges: [],
      trades: [],
      levelChanges: [],
      closed: [],
    };
  }

  const nextBook =
    order.side === 'buy'
      ? { ...book, bids: book.bids.filter(({ id }) => id !== order.id) }
      : { ...book, asks: book.asks.filter(({ id }) => id !== order.id) };
  return {
    book: nextBook,
    outcome: 'applied',
    orderChanges: [{ ...order, status: 'cancelled', cancelReason: 'user' }],
    trades: [],
    levelChanges: changedLevels(nextBook, [order]),
    closed: [close(order, 'user')],
  };
}

export function apply(
  book: Book,
  command: Command,
  { stp = cancelNewest }: { stp?: StpPolicy } = {},
): ApplyResult {
  if (command.type === 'cancel') return cancel(book, command);

  let incoming: BookOrder = { ...command.order, prioritySeq: command.seq };
  const buying = incoming.side === 'buy';
  const opposite = [...(buying ? book.asks : book.bids)].sort(compareOrders);
  const updatedOpposite: BookOrder[] = [];
  const trades: Fill[] = [];
  const orderChanges: OrderChange[] = [];
  const touched: BookOrder[] = [];
  let selfCross = false;
  let index = 0;

  for (; index < opposite.length && incoming.remaining > 0n; index++) {
    const resting = opposite[index];
    if (buying ? incoming.price < resting.price : incoming.price > resting.price) break;
    if (stp(incoming, resting)) {
      selfCross = true;
      break;
    }

    const quantity =
      incoming.remaining < resting.remaining ? incoming.remaining : resting.remaining;
    trades.push({
      tradeId: uuidv5(TRADE_ID_NAMESPACE, `${command.instrument}:${command.seq}:${trades.length}`),
      instrument: command.instrument,
      buyOrderId: buying ? incoming.id : resting.id,
      sellOrderId: buying ? resting.id : incoming.id,
      price: resting.price,
      quantity,
      executedAt: command.acceptedAt,
    });

    incoming = { ...incoming, remaining: incoming.remaining - quantity };
    const maker = { ...resting, remaining: resting.remaining - quantity };
    orderChanges.push({ ...maker, status: orderStatus(maker) });
    touched.push(maker);
    if (maker.remaining > 0n) updatedOpposite.push(maker);
  }
  const nextOpposite = updatedOpposite.concat(opposite.slice(index));

  let nextSame = buying ? book.bids : book.asks;
  const closed: ClosedOrder[] = [];
  if (selfCross) {
    orderChanges.push({ ...incoming, status: 'cancelled', cancelReason: 'self_trade_prevented' });
    closed.push(close(incoming, 'self_trade_prevented'));
  } else {
    orderChanges.push({ ...incoming, status: orderStatus(incoming) });
    if (incoming.remaining > 0n) {
      nextSame = [...nextSame, incoming].sort(compareOrders);
      touched.push(incoming);
    }
  }

  const nextBook = buying
    ? { bids: nextSame, asks: nextOpposite }
    : { bids: nextOpposite, asks: nextSame };
  return {
    book: nextBook,
    outcome: 'applied',
    orderChanges,
    trades,
    levelChanges: changedLevels(nextBook, touched),
    closed,
  };
}
