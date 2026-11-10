export interface Level {
  price: string;
  quantity: string;
}

export interface BookState {
  bids: Level[];
  asks: Level[];
}

export type BookStatus = 'connecting' | 'live' | 'disconnected';

/** Частина Socket.IO-клієнта, потрібна сесії: так її перевіряє тест без мережі. */
export interface SocketLike {
  active: boolean;
  on(event: string, handler: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
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
}

export const RETRY_MIN_MS = 250;
export const RETRY_MAX_MS = 2000;
// Скільки чекати на книгу після `subscribe`, перш ніж підписатися знову.
export const SUBSCRIBE_TIMEOUT_MS = 3000;

const realClock: Clock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Веде книгу одного інструмента на застарілому namespace: підписується після підключення й
 * перепідключається після розриву сервером. Сторінка стає `live` лише після першої книги: саме
 * `connect` ще не означає, що підписка вдалася, а після перепідключення на екрані лишається
 * попередня книга. Успішна підписка ack не має, тож невдачу видно за відсутністю книги
 * (тайм-аут) або за відповіддю `{ok:false}`; в обох випадках підписка повторюється. Повертає
 * функцію зупинки.
 */
export function startBookSession(
  socket: SocketLike,
  instrument: string,
  view: BookView,
  clock: Clock = realClock,
): () => void {
  let retry: unknown;
  let delay = RETRY_MIN_MS;
  let waiting: unknown;
  let resubscribeDelay = RETRY_MIN_MS;

  // Після розриву сервером чи відмови на handshake Socket.IO сам не підключається: потрібен
  // явний connect(). Затримка зростає, щоб відмовлена репліка не отримувала шквал спроб.
  const reconnect = () => {
    clock.clearTimeout(retry);
    retry = clock.setTimeout(() => socket.connect(), delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };

  const subscribe = () => {
    clock.clearTimeout(waiting);
    socket.emit('subscribe', instrument, (reply?: { ok?: boolean }) => {
      if (reply?.ok === false) resubscribe();
    });
    waiting = clock.setTimeout(resubscribe, SUBSCRIBE_TIMEOUT_MS);
  };
  // Пауза зростає, доки не прийде книга, щоб сервер, який не віддає книгу, не отримував шквал.
  const resubscribe = () => {
    clock.clearTimeout(waiting);
    waiting = clock.setTimeout(subscribe, resubscribeDelay);
    resubscribeDelay = Math.min(resubscribeDelay * 2, RETRY_MAX_MS);
  };

  socket.on('connect', () => {
    view.onStatus('connecting');
    subscribe();
  });
  socket.on('book', (data: BookState) => {
    // Затримки скидаються лише після справжньої книги: сервер, що приймає й одразу розриває
    // з'єднання, не повинен отримувати спробу кожні 250 мс.
    delay = RETRY_MIN_MS;
    resubscribeDelay = RETRY_MIN_MS;
    clock.clearTimeout(waiting);
    view.onStatus('live');
    view.onBook(data);
  });
  socket.on('disconnect', (reason: string) => {
    clock.clearTimeout(waiting);
    view.onStatus('disconnected');
    if (reason === 'io server disconnect') reconnect();
  });
  socket.on('connect_error', () => {
    clock.clearTimeout(waiting);
    view.onStatus('disconnected');
    if (!socket.active) reconnect();
  });

  return () => {
    clock.clearTimeout(retry);
    clock.clearTimeout(waiting);
    socket.disconnect();
  };
}
