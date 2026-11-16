'use client';

import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { type Clock, type SocketLike, realClock, RETRY_MIN_MS, RETRY_MAX_MS } from './book-session';
import { type ActiveOrderScan, readActiveOrders } from './active-orders';
import { apiJson, ApiError, errorMessage } from './client-api';
import { bindSession } from './session-binding';
import { startWalletRefresh } from './wallet-refresh';
import {
  type Order,
  type OrderUpdate,
  type Wallet,
  mergeWallet,
  unresolvedOrderIds,
  projectOrder,
  validOrderUpdate,
  validWallet,
} from './private-state';

interface Snapshot {
  orders: Order[];
  wallets: Wallet[];
  absentOrderIds?: string[];
}

interface View {
  onSession?(userId: string | undefined): void;
  onLoading(): void;
  onDisconnected?(): void;
  onError(error: unknown): void;
  onSnapshot(snapshot: Snapshot, signal: AbortSignal): void;
  knownOrderIds(): Iterable<string>;
  onOrder(order: OrderUpdate, signal: AbortSignal): void;
  onWallet(wallet: Wallet): void;
}

type Connect = (
  url: string,
  options: {
    autoConnect: false;
    transports: ['websocket'];
    auth: (done: (value: { token: string }) => void) => void;
  },
) => Pick<SocketLike, 'active' | 'on' | 'connect' | 'disconnect'>;

// Повторюємо лише збій мережі й відповіді, що минають самі. 401, 403, 404 чи хибний снапшот
// від повтору не зміняться, тож їх лишає на банері помилки.
export function transient(error: unknown) {
  if (error instanceof ApiError) return [408, 429, 502, 503, 504].includes(error.status);
  return error instanceof TypeError;
}

interface SnapshotRead {
  signal: AbortSignal;
  clock: Clock;
  onLimited(error: unknown): void;
}

// Ingress обмежує читання заявок на токен і повертає квоту щосекунди. Повтор розкидано на 1–2 с:
// після failover термінали отримують 429 разом і не мають разом повторити.
const READ_LIMIT_RETRY_MS = 1000;
const readLimitRetryMs = () =>
  READ_LIMIT_RETRY_MS + Math.floor(Math.random() * READ_LIMIT_RETRY_MS);
const PARALLEL_ORDER_READS = 8;

/**
 * Читання для знімка (заявки й гаманці). На 429 повторює лише цей запит, коли квота відновиться: повтор
 * усього знімка знову витратив би квоту на вже прочитане і не завершився б, якщо знімок
 * потребує більше читань, ніж вміщує квота.
 */
async function readOrders<T>(path: string, read: SnapshotRead): Promise<T> {
  const { signal, clock } = read;
  for (;;) {
    try {
      return await apiJson<T>(path, { signal });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 429) || signal.aborted) throw error;
      // Банер показує, чому знімок затримується; вдалий знімок його знімає.
      read.onLimited(error);
      await new Promise<void>((resolve) => {
        const timer = clock.setTimeout(done, readLimitRetryMs());
        function done() {
          signal.removeEventListener('abort', cancel);
          resolve();
        }
        function cancel() {
          clock.clearTimeout(timer);
          resolve();
        }
        signal.addEventListener('abort', cancel, { once: true });
      });
      if (signal.aborted) throw error;
    }
  }
}

/** Заявки за ID не більше ніж по кілька одночасно, щоб не вичерпати квоту одним сплеском. */
async function readOrdersById(
  ids: string[],
  read: SnapshotRead,
  resolved: Map<string, Order | null>,
) {
  const missing = ids.filter((id) => !resolved.has(id));
  let next = 0;
  async function worker() {
    // Спроба, що вже впала, скасовує свій signal: решта воркерів не витрачає квоту даремно.
    while (next < missing.length && !read.signal.aborted) {
      const id = missing[next++];
      try {
        const order = await readOrders<Order>('/api/engine/orders/' + encodeURIComponent(id), read);
        if (!read.signal.aborted) resolved.set(id, order);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404) || read.signal.aborted)
          throw error;
        resolved.set(id, null);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_ORDER_READS, missing.length) }, worker));
  return ids.map((id) => resolved.get(id));
}

function readActive(read: SnapshotRead, scan: ActiveOrderScan<Order>) {
  return readActiveOrders(
    async (query) => {
      const page = await readOrders<Order[]>('/api/engine/orders?' + query, read);
      read.signal.throwIfAborted();
      return page;
    },
    100,
    scan,
  );
}

interface OrderRead {
  onOrder(order: Order): void;
  onError(error: unknown): void;
  /** Читання завершене: заявку отримано, помилка остаточна або сесію закрито. */
  onSettled(reason?: 'deadline'): void;
}

/**
 * Дочитує заявку за ID. Тимчасову помилку повторює на тому ж з'єднанні: інакше відкрита
 * заявка без нових подій не з'явиться до перепідключення.
 */
export function readOrder(
  id: string,
  signal: AbortSignal,
  read: OrderRead,
  clock: Clock = realClock,
) {
  if (signal.aborted) return read.onSettled();
  const parent = signal;
  const budget = new AbortController();
  signal = AbortSignal.any([parent, budget.signal]);
  const deadline = clock.setTimeout(
    () => budget.abort(new TypeError('Order read deadline exceeded')),
    15000,
  );
  let timer: unknown;
  let delay = RETRY_MIN_MS;
  const abort = () => {
    clock.clearTimeout(deadline);
    if (!parent.aborted) read.onError(signal.reason);
    clock.clearTimeout(timer);
    read.onSettled(parent.aborted ? undefined : 'deadline');
  };
  if (signal.aborted) return read.onSettled();
  signal.addEventListener('abort', abort, { once: true });
  const settle = () => {
    clock.clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    read.onSettled();
  };

  function attempt() {
    void apiJson<Order>('/api/engine/orders/' + encodeURIComponent(id), { signal }).then(
      (order) => {
        if (signal.aborted) return;
        try {
          read.onOrder(order);
        } catch (error) {
          read.onError(error);
        } finally {
          settle();
        }
      },
      (error: unknown) => {
        if (signal.aborted) return;
        read.onError(error);
        if (!transient(error)) return settle();
        timer = clock.setTimeout(attempt, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      },
    );
  }
  attempt();
}

export function startPrivateSocket(
  url: string,
  view: View,
  clock: Clock = realClock,
  connect: Connect = io,
) {
  const lifetime = new AbortController();
  let session: AbortController | undefined;
  let retry: unknown;
  let delay = RETRY_MIN_MS;
  let signedOut = false;
  let loadRetry: unknown;
  let loadDelay = RETRY_MIN_MS;
  let walletRefresh: ReturnType<typeof startWalletRefresh<Wallet[]>> | undefined;

  const socket = connect(url + '/private', {
    autoConnect: false,
    transports: ['websocket'],
    auth(done) {
      void apiJson<{ token: string; userId?: string }>('/api/auth/ws-token', {
        method: 'POST',
        signal: lifetime.signal,
      })
        .then(({ token, userId }) => {
          if (lifetime.signal.aborted) return;
          view.onSession?.(userId);
          done({ token });
        })
        .catch((error: unknown) => {
          if (lifetime.signal.aborted) return;
          signedOut = error instanceof ApiError && error.status === 401;
          view.onError(error);
          done({ token: '' });
        });
    },
  });

  function reconnect() {
    if (signedOut || lifetime.signal.aborted) return;
    clock.clearTimeout(retry);
    retry = clock.setTimeout(() => socket.connect(), delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }

  function load(
    session: AbortSignal,
    resolved: Map<string, Order | null>,
    activeScan: ActiveOrderScan<Order>,
  ) {
    // Своя спроба на кожне читання знімка: після збою її запити зупиняються, а не конкурують
    // за квоту читань із наступною спробою.
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    session.addEventListener('abort', abort, { once: true });
    const deadline = clock.setTimeout(
      () => attempt.abort(new TypeError('Snapshot deadline exceeded')),
      15000,
    );
    let limited = false;
    const read: SnapshotRead = {
      signal: attempt.signal,
      clock,
      // Один банер на спробу, а не на кожну секунду очікування кожного воркера.
      onLimited: (error) => {
        if (limited) return;
        limited = true;
        view.onError(error);
      },
    };
    const signal = attempt.signal;
    void Promise.all([
      readActive(read, activeScan),
      readOrders<Order[]>('/api/engine/orders?status=filled&limit=100', read),
      // Окремий фільтр: серед останніх 100 будь-якого статусу скасованих могло й не бути.
      readOrders<Order[]>('/api/engine/orders?status=cancelled&limit=100', read),
      // Ingress обмежує й гаманці: 429 повторює лише це читання, а не весь знімок.
      readOrders<Wallet[]>('/api/settlement/wallets', read),
    ])
      .then(async ([active, filled, cancelled, wallets]) => {
        if (signal.aborted) return;
        // Запити виконуються паралельно, тож для однієї заявки береться новіша версія.
        const byId = new Map<string, Order>();
        for (const order of [...filled, ...cancelled, ...active]) {
          const known = byId.get(order.id);
          if (!known || order.version >= known.version) byId.set(order.id, order);
        }
        const orders = [...byId.values()];
        // Заявка, відсутня у списку, могла завершитися між з'єднаннями.
        const missing = [...view.knownOrderIds()].filter((id) => !byId.has(id));
        const recovered = await readOrdersById(missing, read, resolved);
        if (signal.aborted) return;
        orders.push(...recovered.filter((order): order is Order => Boolean(order)));
        const absentOrderIds = missing.filter((id) => resolved.get(id) === null);
        view.onSnapshot(
          { orders, wallets, ...(absentOrderIds.length && { absentOrderIds }) },
          session,
        );
        walletRefresh?.start();
        loadDelay = RETRY_MIN_MS;
      })
      .catch((error: unknown) => {
        const failure = signal.aborted ? signal.reason : error;
        attempt.abort();
        if (session.aborted) return;
        view.onError(failure);
        // Сокет лишається підключеним, тож подій не буде, доки читання не вдасться.
        if (!transient(failure)) return;
        clock.clearTimeout(loadRetry);
        loadRetry = clock.setTimeout(() => {
          if (!session.aborted) load(session, resolved, activeScan);
        }, loadDelay);
        loadDelay = Math.min(loadDelay * 2, RETRY_MAX_MS);
      })
      .finally(() => {
        clock.clearTimeout(deadline);
        session.removeEventListener('abort', abort);
      });
  }

  socket.on('connect', () => {
    session?.abort();
    session = new AbortController();
    const { signal } = session;
    clock.clearTimeout(retry);
    clock.clearTimeout(loadRetry);
    delay = RETRY_MIN_MS;
    loadDelay = RETRY_MIN_MS;
    walletRefresh?.stop();
    walletRefresh = startWalletRefresh(
      (readSignal) => apiJson<Wallet[]>('/api/settlement/wallets', { signal: readSignal }),
      (wallets) => {
        // Хибна фонова відповідь не ставить банер, якого жодне вдале читання вже не зняло б.
        // Хибні записи відкидаємо, валідні гаманці незалежні й застосовуються; наступна звірка
        // читає знову. Snapshot після перепідключення таку відповідь показує.
        if (!Array.isArray(wallets)) return;
        for (const wallet of wallets) if (validWallet(wallet)) view.onWallet(wallet);
      },
      clock,
    );
    view.onLoading();
    load(signal, new Map(), { rows: [], cursor: '', complete: false });
  });
  socket.on('disconnect', (reason: string) => {
    session?.abort();
    clock.clearTimeout(loadRetry);
    walletRefresh?.stop();
    walletRefresh = undefined;
    if (lifetime.signal.aborted) return;
    view.onDisconnected?.();
    if (reason === 'io server disconnect') reconnect();
  });
  socket.on('connect_error', () => {
    if (!signedOut && !lifetime.signal.aborted) view.onDisconnected?.();
    if (!socket.active) reconnect();
  });
  socket.on('wallet.updated', (wallet: Wallet) => {
    if (session && !session.signal.aborted) view.onWallet(wallet);
  });
  socket.on('order.updated', (order: OrderUpdate) => {
    if (!session || session.signal.aborted) return;
    view.onOrder(order, session.signal);
    walletRefresh?.changed();
  });
  socket.connect();

  const stop = () => {
    lifetime.abort();
    session?.abort();
    clock.clearTimeout(retry);
    clock.clearTimeout(loadRetry);
    walletRefresh?.stop();
    socket.disconnect();
  };
  stop.resync = () => {
    session?.abort();
    socket.disconnect();
    reconnect();
  };
  return stop;
}

export function usePrivateSocket(url: string | undefined) {
  const [data, setData] = useState<Snapshot>({ orders: [], wallets: [] });
  const [status, setStatus] = useState<'loading' | 'reconnecting' | 'live' | 'error'>('loading');
  const [error, setError] = useState('');
  const [userId, setUserId] = useState<string>();
  const receiveOrder = useRef<(order: Order) => void>(() => undefined);

  useEffect(() => {
    if (!url) return;
    let loading = true;
    let orderOverflow = false;
    let known: string | undefined;
    const orders = new Map<string, Order>();
    const wallets = new Map<string, Wallet>();
    const pendingOrders = new Map<string, OrderUpdate>();
    const submitted = new Map<string, Order>();
    const pendingWallets = new Map<string, Wallet>();
    const reads = new Map<string, AbortSignal>();

    let shown: unknown;

    const publish = () => setData({ orders: [...orders.values()], wallets: [...wallets.values()] });
    const onError = (error: unknown) => {
      shown = error;
      setError(errorMessage(error));
      setStatus('error');
    };

    function storeOrder(value: Order) {
      const order = projectOrder(value);
      const previous = orders.get(order.id);
      const next = previous && previous.version >= order.version ? previous : order;
      orders.set(order.id, next);
    }

    function applyOrder(update: OrderUpdate, signal: AbortSignal) {
      if (signal.aborted) return;
      const previous = orders.get(update.orderId);
      if (previous) {
        if (update.version <= previous.version) return;
        const { version, status, filledQuantity, remainingQuantity, cancelReason } = update;
        storeOrder({
          ...previous,
          version,
          status,
          filledQuantity,
          remainingQuantity,
          cancelReason,
        });
        publish();
        return;
      }
      if (reads.get(update.orderId) === signal) return;
      if (reads.size >= PARALLEL_ORDER_READS) {
        stop.resync();
        return;
      }
      reads.set(update.orderId, signal);
      // Подія не несе ціну й сторону нової заявки, тому дочитуємо її за ID.
      let failure: unknown;
      readOrder(update.orderId, signal, {
        onOrder(order) {
          storeOrder(order);
          const newest = pendingOrders.get(update.orderId);
          if (newest) applyOrder(newest, signal);
          // Банер тимчасового збою цього читання знімаємо, чужу помилку лишаємо.
          if (failure !== undefined && shown === failure) {
            setError('');
            setStatus('live');
          }
          publish();
        },
        onError(error) {
          failure = error;
          onError(error);
        },
        onSettled(reason) {
          if (reads.get(update.orderId) !== signal) return;
          reads.delete(update.orderId);
          if (reason === 'deadline') {
            stop.resync();
            return;
          }
          if (signal.aborted) return;
          pendingOrders.delete(update.orderId);
        },
      });
    }

    receiveOrder.current = (order) => {
      try {
        storeOrder(order);
        if (loading) submitted.set(order.id, orders.get(order.id)!);
        publish();
      } catch (error) {
        onError(error);
      }
    };

    const stop = startPrivateSocket(url, {
      onLoading() {
        loading = true;
        orderOverflow = false;
        reads.clear();
        pendingWallets.clear();
        setStatus('loading');
      },
      onDisconnected() {
        setStatus('reconnecting');
      },
      onError,
      knownOrderIds() {
        // Завершену заявку не перечитують: її стан у снапшоті не зміниться.
        return unresolvedOrderIds(orders.values(), pendingOrders.keys());
      },
      onSession(id) {
        if (known !== undefined && id !== known) return window.location.reload();
        known = id;
        bindSession(id);
        setUserId(id);
      },
      onSnapshot(snapshot, signal) {
        const latest = snapshot.orders.map(projectOrder);
        if (!snapshot.wallets.every(validWallet)) throw new Error('Invalid wallet snapshot');
        orders.clear();
        for (const order of latest) storeOrder(order);
        for (const order of submitted.values()) storeOrder(order);
        submitted.clear();
        wallets.clear();
        for (const id of snapshot.absentOrderIds ?? []) pendingOrders.delete(id);
        for (const wallet of [...snapshot.wallets, ...pendingWallets.values()]) {
          wallets.set(wallet.asset, mergeWallet(wallets.get(wallet.asset), wallet)!);
        }
        loading = false;
        for (const [id, update] of pendingOrders) {
          applyOrder(update, signal);
          if (signal.aborted) return;
          if (!reads.has(id)) pendingOrders.delete(id);
        }
        pendingWallets.clear();
        if (orderOverflow) {
          // Спершу завершити snapshot, інакше повний буфер скасовує кожен новий запуск.
          pendingOrders.clear();
          publish();
          stop.resync();
          return;
        }
        shown = undefined;
        setError('');
        setStatus('live');
        publish();
      },
      onWallet(update) {
        if (!validWallet(update)) return onError(new Error('Invalid wallet event'));
        const target = loading ? pendingWallets : wallets;
        target.set(update.asset, mergeWallet(target.get(update.asset), update)!);
        if (!loading) publish();
      },
      onOrder(update, signal) {
        if (!validOrderUpdate(update)) return onError(new Error('Invalid order event'));
        if (loading || !orders.has(update.orderId)) {
          const previous = pendingOrders.get(update.orderId);
          if (previous && previous.version >= update.version) return;
          if (!pendingOrders.has(update.orderId) && pendingOrders.size >= 1000) {
            if (loading) orderOverflow = true;
            else {
              pendingOrders.clear();
              stop.resync();
            }
            return;
          }
          pendingOrders.set(update.orderId, update);
        }
        if (!loading) applyOrder(update, signal);
      },
    });
    return () => {
      stop();
      bindSession(undefined);
      setUserId(undefined);
      receiveOrder.current = () => undefined;
    };
  }, [url]);

  return {
    ...data,
    status,
    error,
    userId,
    updateOrder: (order: Order) => receiveOrder.current(order),
  };
}
