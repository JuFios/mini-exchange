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

const realClock: Clock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Веде книгу одного інструмента на застарілому namespace: підписується після підключення й
 * перепідключається після розриву сервером. Повертає функцію зупинки.
 */
export function startBookSession(
  socket: SocketLike,
  instrument: string,
  view: BookView,
  clock: Clock = realClock,
): () => void {
  let retry: unknown;
  let delay = RETRY_MIN_MS;

  // Після розриву сервером чи відмови на handshake Socket.IO сам не підключається: потрібен
  // явний connect(). Затримка зростає, щоб відмовлена репліка не отримувала шквал спроб.
  const reconnect = () => {
    clock.clearTimeout(retry);
    retry = clock.setTimeout(() => socket.connect(), delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };

  socket.on('connect', () => {
    view.onStatus('live');
    socket.emit('subscribe', instrument);
  });
  socket.on('book', (data: BookState) => {
    // Затримка скидається лише після справжньої книги: сервер, що приймає й одразу розриває
    // з'єднання, не повинен отримувати спробу кожні 250 мс.
    delay = RETRY_MIN_MS;
    view.onBook(data);
  });
  socket.on('disconnect', (reason: string) => {
    view.onStatus('disconnected');
    if (reason === 'io server disconnect') reconnect();
  });
  socket.on('connect_error', () => {
    view.onStatus('disconnected');
    if (!socket.active) reconnect();
  });

  return () => {
    clock.clearTimeout(retry);
    socket.disconnect();
  };
}
