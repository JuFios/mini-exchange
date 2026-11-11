export interface Level {
  price: string;
  quantity: string;
  orders: number;
}

export interface BookState {
  instrument: string;
  seq: string;
  bids: Level[];
  asks: Level[];
}

export type BookStatus = 'loading' | 'live' | 'reconnecting' | 'stale' | 'error';

/** Частина Socket.IO-клієнта, потрібна сесії: так її перевіряє тест без мережі. */
export interface SocketLike {
  active: boolean;
  on(event: string, handler: (...args: never[]) => void): unknown;
  timeout(ms: number): { emit(event: string, ...args: unknown[]): unknown };
  connect(): unknown;
  disconnect(): unknown;
}

export interface Clock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BookView {
  onStatus(status: BookStatus): void;
  onBook(book: BookState): void;
  onSnapshot?(): void;
}

export const RETRY_MIN_MS = 250;
export const RETRY_MAX_MS = 2000;
// Скільки чекати на книгу після `subscribe`, перш ніж підписатися знову.
export const SUBSCRIBE_TIMEOUT_MS = 3000;
// Сервер надсилає heartbeat кожні 2 с. Чотири інтервали дають запас на затримки.
export const HEARTBEAT_TIMEOUT_MS = 8000;
// Повтор першої підписки після вичерпання швидких спроб: одна спроба на серверне вікно ліміту.
export const SLOW_RETRY_MS = 10_000;

export const realClock: Clock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Change = Level & { side: 'bid' | 'ask' };
type Delta = { instrument: string; seq: string; changes: Change[] };
type Reply = { ok: true; snapshot: BookState } | { ok: false };

const isSequence = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value);

const isAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);

const validLevel = (level: Level) =>
  level &&
  isAmount(level.price) &&
  isAmount(level.quantity) &&
  Number.isSafeInteger(level.orders) &&
  level.orders >= 0;

const projectLevel = ({ price, quantity, orders }: Level) => ({ price, quantity, orders });

function validSnapshot(value: BookState | undefined, instrument: string): value is BookState {
  return (
    value?.instrument === instrument &&
    isSequence(value.seq) &&
    Array.isArray(value.bids) &&
    value.bids.every(validLevel) &&
    Array.isArray(value.asks) &&
    value.asks.every(validLevel)
  );
}

function apply(book: BookState, seq: bigint, changes: Change[]): BookState {
  const side = (name: Change['side'], current: Level[]) => {
    const rows = new Map(current.map((level) => [level.price, level]));
    for (const { side, price, quantity, orders } of changes) {
      if (side !== name) continue;
      if (orders === 0 || Number(quantity) === 0) rows.delete(price);
      else rows.set(price, { price, quantity, orders });
    }
    // Ціна має два знаки й обмежена мільйоном, тож порівняння не зливає різні тіки.
    const direction = name === 'bid' ? -1 : 1;
    return [...rows.values()]
      .sort((a, b) => direction * (Number(a.price) - Number(b.price)))
      .slice(0, 50);
  };
  return {
    instrument: book.instrument,
    seq: String(seq),
    bids: side('bid', book.bids),
    asks: side('ask', book.asks),
  };
}

// Snapshot і heartbeat підтверджують свіжість. Після розриву потоку потрібен новий snapshot.
export function startBookSession(
  socket: SocketLike,
  instrument: string,
  view: BookView,
  clock: Clock = realClock,
): () => void {
  let status: BookStatus = 'reconnecting';
  let book: BookState | undefined;
  let heartbeat: bigint | undefined;
  const buffered = new Map<bigint, Change[]>();
  let retry: unknown;
  let waiting: unknown;
  let heartbeatTimer: unknown;
  let awaitingHeartbeat = false;
  let resyncPending = false;
  let reconnectDelay = RETRY_MIN_MS;
  let failures = 0;
  let requestId = 0;
  let stopped = false;

  function setStatus(next: BookStatus) {
    if (status === next) return;
    status = next;
    view.onStatus(next);
  }

  function armHeartbeatTimeout() {
    clock.clearTimeout(heartbeatTimer);
    heartbeatTimer = clock.setTimeout(() => {
      awaitingHeartbeat = true;
      setStatus('stale');
    }, HEARTBEAT_TIMEOUT_MS);
  }

  function reconnect() {
    clock.clearTimeout(retry);
    retry = clock.setTimeout(() => socket.connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RETRY_MAX_MS);
  }

  function failSnapshot() {
    if (failures === 5) {
      buffered.clear();
      resyncPending = false;
      if (status === 'loading') {
        // Книга ще не стала live на цьому з'єднанні: сокет може бути поза кімнатою heartbeat.
        waiting = clock.setTimeout(() => {
          setStatus('loading');
          subscribe();
        }, SLOW_RETRY_MS);
      } else {
        // Уже підписаний сокет отримає heartbeat, коли сервер знову підтвердить свіжість.
        awaitingHeartbeat = true;
      }
      setStatus('error');
      return;
    }
    waiting = clock.setTimeout(subscribe, Math.min(RETRY_MIN_MS * 2 ** failures, RETRY_MAX_MS));
    failures++;
  }

  function subscribe() {
    const id = ++requestId;
    const finish = (error: Error | null, reply?: Reply) => {
      if (id !== requestId) return;
      requestId++;
      if (error || !reply?.ok || !validSnapshot(reply.snapshot, instrument)) return failSnapshot();

      let next = {
        instrument,
        seq: reply.snapshot.seq,
        bids: reply.snapshot.bids.slice(0, 50).map(projectLevel),
        asks: reply.snapshot.asks.slice(0, 50).map(projectLevel),
      };
      if (book && BigInt(next.seq) < BigInt(book.seq)) return failSnapshot();
      const pending = [...buffered.keys()].sort((a, b) => (a < b ? -1 : 1));
      for (const seq of pending) {
        const applied = BigInt(next.seq);
        if (seq > applied + 1n) return failSnapshot();
        if (seq > applied) next = apply(next, seq, buffered.get(seq)!);
      }

      buffered.clear();
      heartbeat = undefined;
      reconnectDelay = RETRY_MIN_MS;
      failures = 0;
      book = next;
      // Якщо розрив зафіксовано під час читання, цей snapshot міг його ще не охопити.
      if (resyncPending) {
        resyncPending = false;
        subscribe();
        return;
      }
      armHeartbeatTimeout();
      view.onBook(book);
      setStatus('live');
      view.onSnapshot?.();
    };

    socket.timeout(SUBSCRIBE_TIMEOUT_MS).emit('book.subscribe', { instrument }, finish);
  }

  function recover() {
    clock.clearTimeout(heartbeatTimer);
    setStatus('stale');
    subscribe();
  }

  function cancelPending() {
    requestId++;
    clock.clearTimeout(waiting);
    clock.clearTimeout(retry);
    clock.clearTimeout(heartbeatTimer);
    awaitingHeartbeat = false;
    resyncPending = false;
    buffered.clear();
    heartbeat = undefined;
  }

  socket.on('connect', () => {
    if (stopped) return;
    cancelPending();
    failures = 0;
    setStatus('loading');
    subscribe();
  });
  socket.on('book.delta', (event: Delta) => {
    if (stopped || event?.instrument !== instrument) return;
    if (awaitingHeartbeat || status === 'reconnecting' || status === 'error') return;
    if (
      !isSequence(event.seq) ||
      !Array.isArray(event.changes) ||
      !event.changes.every(
        (change) => validLevel(change) && (change.side === 'bid' || change.side === 'ask'),
      )
    ) {
      if (status === 'live') recover();
      return;
    }
    const seq = BigInt(event.seq);
    if (book && seq <= BigInt(book.seq)) return;
    if (status === 'live' && book && seq === BigInt(book.seq) + 1n) {
      book = apply(book, seq, event.changes);
      view.onBook(book);
      return;
    }
    buffered.set(seq, event.changes);
    if (status === 'live') recover();
  });
  socket.on('book.resync', (event: { instrument: string }) => {
    if (stopped || awaitingHeartbeat || event?.instrument !== instrument) return;
    if (status === 'live') recover();
    else if (status === 'loading' || status === 'stale') resyncPending = true;
  });
  socket.on('book.heartbeat', (event: { instrument: string; seq: string }) => {
    if (stopped || event?.instrument !== instrument) return;
    if (awaitingHeartbeat) {
      if (!isSequence(event.seq)) return;
      awaitingHeartbeat = false;
      failures = 0;
      return recover();
    }
    if (status !== 'live' || !book) return;
    if (!isSequence(event.seq) || (heartbeat !== undefined && heartbeat > BigInt(book.seq))) {
      return recover();
    }
    heartbeat = BigInt(event.seq);
    armHeartbeatTimeout();
  });
  socket.on('disconnect', (reason: string) => {
    if (stopped) return;
    cancelPending();
    setStatus('reconnecting');
    if (reason === 'io server disconnect') reconnect();
  });
  socket.on('connect_error', () => {
    if (stopped) return;
    cancelPending();
    setStatus('reconnecting');
    if (!socket.active) reconnect();
  });

  return () => {
    stopped = true;
    cancelPending();
    socket.disconnect();
  };
}
