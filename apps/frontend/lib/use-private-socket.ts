'use client';

import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { type Clock, type SocketLike, realClock, RETRY_MIN_MS, RETRY_MAX_MS } from './book-session';
import { apiJson, ApiError, errorMessage } from './client-api';
import {
  type Order,
  type OrderUpdate,
  type Wallet,
  finishAttempt,
  mergeWallet,
  projectOrder,
  validOrderUpdate,
  validWallet,
} from './private-state';

interface Snapshot {
  orders: Order[];
  wallets: Wallet[];
}

interface View {
  onLoading(): void;
  onDisconnected?(): void;
  onError(error: unknown): void;
  onSnapshot(snapshot: Snapshot, signal: AbortSignal): void;
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

  const socket = connect(url + '/private', {
    autoConnect: false,
    transports: ['websocket'],
    auth(done) {
      void apiJson<{ token: string }>('/api/auth/ws-token', {
        method: 'POST',
        signal: lifetime.signal,
      })
        .then(({ token }) => {
          if (!lifetime.signal.aborted) done({ token });
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

  socket.on('connect', () => {
    session?.abort();
    session = new AbortController();
    const { signal } = session;
    clock.clearTimeout(retry);
    delay = RETRY_MIN_MS;
    view.onLoading();
    void Promise.all([
      apiJson<Order[]>('/api/engine/orders?status=active', { signal }),
      apiJson<Order[]>('/api/engine/orders?status=filled', { signal }),
      apiJson<Wallet[]>('/api/settlement/wallets', { signal }),
    ])
      .then(([active, filled, wallets]) => {
        if (signal.aborted) return;
        view.onSnapshot({ orders: [...active, ...filled], wallets }, signal);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) view.onError(error);
      });
  });
  socket.on('disconnect', (reason: string) => {
    session?.abort();
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
    if (session && !session.signal.aborted) view.onOrder(order, session.signal);
  });
  socket.connect();

  return () => {
    lifetime.abort();
    session?.abort();
    clock.clearTimeout(retry);
    socket.disconnect();
  };
}

export function usePrivateSocket(url: string | undefined) {
  const [data, setData] = useState<Snapshot>({ orders: [], wallets: [] });
  const [status, setStatus] = useState<'loading' | 'reconnecting' | 'live' | 'error'>('loading');
  const [error, setError] = useState('');
  const receiveOrder = useRef<(order: Order) => void>(() => undefined);

  useEffect(() => {
    if (!url) return;
    let loading = true;
    const orders = new Map<string, Order>();
    const wallets = new Map<string, Wallet>();
    const pendingOrders = new Map<string, OrderUpdate>();
    const submitted = new Map<string, Order>();
    const pendingWallets = new Map<string, Wallet>();
    const reads = new Map<string, AbortSignal>();

    const publish = () => setData({ orders: [...orders.values()], wallets: [...wallets.values()] });
    const onError = (error: unknown) => {
      setError(errorMessage(error));
      setStatus('error');
    };

    function storeOrder(value: Order) {
      const order = projectOrder(value);
      const previous = orders.get(order.id);
      const next = previous && previous.version >= order.version ? previous : order;
      orders.set(order.id, next);
      finishAttempt(next);
    }

    function applyOrder(update: OrderUpdate, signal: AbortSignal) {
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
      reads.set(update.orderId, signal);
      // Подія не несе ціну й сторону нової заявки, тому дочитуємо її за ID.
      void apiJson<Order>('/api/engine/orders/' + encodeURIComponent(update.orderId), { signal })
        .then((order) => {
          if (signal.aborted) return;
          storeOrder(order);
          const newest = pendingOrders.get(update.orderId);
          if (newest) applyOrder(newest, signal);
          publish();
        })
        .catch((error: unknown) => {
          if (!signal.aborted) onError(error);
        })
        .finally(() => {
          if (reads.get(update.orderId) !== signal) return;
          reads.delete(update.orderId);
          pendingOrders.delete(update.orderId);
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
        reads.clear();
        pendingOrders.clear();
        pendingWallets.clear();
        setStatus('loading');
      },
      onDisconnected() {
        setStatus('reconnecting');
      },
      onError,
      onSnapshot(snapshot, signal) {
        const latest = snapshot.orders.map(projectOrder);
        if (!snapshot.wallets.every(validWallet)) throw new Error('Invalid wallet snapshot');
        orders.clear();
        for (const order of latest) storeOrder(order);
        for (const order of submitted.values()) storeOrder(order);
        submitted.clear();
        for (const wallet of [...snapshot.wallets, ...pendingWallets.values()]) {
          wallets.set(wallet.asset, mergeWallet(wallets.get(wallet.asset), wallet)!);
        }
        loading = false;
        for (const [id, update] of pendingOrders) {
          applyOrder(update, signal);
          if (!reads.has(id)) pendingOrders.delete(id);
        }
        pendingWallets.clear();
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
          pendingOrders.set(update.orderId, update);
        }
        if (!loading) applyOrder(update, signal);
      },
    });
    return () => {
      stop();
      receiveOrder.current = () => undefined;
    };
  }, [url]);

  return { ...data, status, error, updateOrder: (order: Order) => receiveOrder.current(order) };
}
