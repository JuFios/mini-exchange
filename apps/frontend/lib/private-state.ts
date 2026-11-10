import { fixedAmount, type OrderInput } from './decimal';

export interface Wallet {
  asset: string;
  available: string;
  reserved: string;
  version: string;
}

export type OrderStatus = 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled';

export interface Order extends OrderInput {
  id: string;
  status: OrderStatus;
  version: number;
  remainingQuantity: string;
  filledQuantity: string;
  createdAt: string;
  cancelReason?: string | null;
}

export interface OrderUpdate {
  orderId: string;
  instrument: string;
  status: OrderStatus;
  version: number;
  remainingQuantity: string;
  filledQuantity: string;
  cancelReason?: string | null;
}

const amount = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);

export function validWallet(wallet: Wallet) {
  return (
    wallet &&
    typeof wallet.asset === 'string' &&
    amount(wallet.available) &&
    amount(wallet.reserved) &&
    typeof wallet.version === 'string' &&
    /^\d+$/.test(wallet.version)
  );
}

export function mergeWallet(current: Wallet | undefined, update: Wallet): Wallet | undefined {
  if (!validWallet(update) || (current && BigInt(update.version) <= BigInt(current.version)))
    return current;
  const { asset, available, reserved, version } = update;
  return { asset, available, reserved, version };
}

export const activeOrder = (order: Order) =>
  order.status === 'pending' || order.status === 'open' || order.status === 'partially_filled';

export function orderFeedback(submitted: Order, orders: readonly Order[]) {
  const order =
    orders.find(({ id, version }) => id === submitted.id && version > submitted.version) ??
    submitted;

  if (order.status === 'pending') {
    return { message: 'Заявку прийнято. Очікуємо виконання команди.', failed: false };
  }
  if (order.status === 'filled') return { message: 'Заявку виконано.', failed: false };
  if (order.status !== 'cancelled') return { message: 'Заявку додано до книги.', failed: false };

  if (order.cancelReason === 'self_trade_prevented') {
    return {
      message:
        Number(order.filledQuantity) > 0
          ? 'Залишок заявки скасовано, щоб уникнути угоди з власною заявкою.'
          : 'Заявку скасовано, щоб уникнути угоди з власною заявкою.',
      failed: true,
    };
  }
  if (order.cancelReason === 'rejected') return { message: 'Заявку відхилено.', failed: true };
  return { message: 'Заявку скасовано.', failed: false };
}

export function validOrderUpdate(update: OrderUpdate) {
  return (
    update &&
    typeof update.orderId === 'string' &&
    typeof update.instrument === 'string' &&
    ['pending', 'open', 'partially_filled', 'filled', 'cancelled'].includes(update.status) &&
    Number.isSafeInteger(update.version) &&
    update.version >= 0 &&
    amount(update.remainingQuantity) &&
    amount(update.filledQuantity) &&
    (update.cancelReason == null || typeof update.cancelReason === 'string')
  );
}

export function projectOrder(order: Order): Order {
  const {
    id,
    instrument,
    side,
    price,
    quantity,
    createdAt,
    status,
    version,
    remainingQuantity,
    filledQuantity,
    cancelReason,
  } = order;
  if (
    !validOrderUpdate({
      orderId: id,
      instrument,
      status,
      version,
      remainingQuantity,
      filledQuantity,
      cancelReason,
    }) ||
    !amount(price) ||
    !amount(quantity) ||
    !['buy', 'sell'].includes(side) ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('Invalid order snapshot');
  }
  return {
    id,
    instrument,
    side,
    price,
    quantity,
    createdAt,
    status,
    version,
    remainingQuantity,
    filledQuantity,
    cancelReason,
  };
}

export function attemptKey({ instrument, side, price, quantity }: OrderInput) {
  return (
    'exchange.order.' +
    JSON.stringify([instrument, side, fixedAmount(price, 2), fixedAmount(quantity, 8)])
  );
}

export function finishAttempt(order: Order) {
  if (order.status === 'pending') return;
  const key = attemptKey(order);
  try {
    if (JSON.parse(sessionStorage.getItem(key) ?? 'null')?.orderId === order.id) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Відображення підтвердженої заявки не залежить від доступу до sessionStorage.
  }
}
