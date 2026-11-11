import { type Clock, type SocketLike, RETRY_MAX_MS, realClock } from './book-session';
import { ApiError } from './client-api';
import { transient } from './use-private-socket';

// Як часто звіряти стрічку з REST, поки heartbeat підтверджує з'єднання.
export const HISTORY_REFRESH_MS = 10_000;
// Скільки чекати на відповідь історії, перш ніж показати помилку.
export const HISTORY_TIMEOUT_MS = 3000;

export interface HistoryView<T> {
  onRows(rows: T): void;
  onError(error: unknown): void;
}

/**
 * Читає історію угод після кожного snapshot, а далі за heartbeat інструмента. Хвіст Redis може
 * втратити лише угоду: seq книги лишається актуальним, і без звірки стрічка не відновилася б.
 */
export function startTradeHistory<T>(
  socket: Pick<SocketLike, 'on'>,
  instrument: string,
  read: (signal: AbortSignal) => Promise<T>,
  view: HistoryView<T>,
  clock: Clock = realClock,
  now: () => number = () => performance.now(),
) {
  let request: AbortController | undefined;
  let deadline: unknown;
  let nextAt = Infinity;
  let retryDelay = RETRY_MAX_MS;
  let stopped = false;

  function cancel() {
    request?.abort();
    request = undefined;
    clock.clearTimeout(deadline);
  }

  function load() {
    if (stopped) return;
    cancel();
    const current = new AbortController();
    request = current;
    let timedOut = false;
    deadline = clock.setTimeout(() => {
      timedOut = true;
      current.abort();
    }, HISTORY_TIMEOUT_MS);
    const settle = (delay: number) => {
      clock.clearTimeout(deadline);
      request = undefined;
      nextAt = now() + delay;
    };
    read(current.signal).then(
      (rows) => {
        if (request !== current) return;
        retryDelay = RETRY_MAX_MS;
        settle(HISTORY_REFRESH_MS);
        view.onRows(rows);
      },
      (error: unknown) => {
        if (request !== current) return;
        // Помилку клієнта чи хибну відповідь повтор не виправить: читання запустить новий snapshot.
        // Решту повторюємо з паузою, що росте до звичайного інтервалу: інакше збій сервера
        // або 429 множив би запити всіх вкладок під спільним лімітом IP.
        const retryable =
          timedOut || transient(error) || (error instanceof ApiError && error.status >= 500);
        settle(retryable ? retryDelay : Infinity);
        if (retryable) retryDelay = Math.min(retryDelay * 2, HISTORY_REFRESH_MS);
        view.onError(error);
      },
    );
  }

  socket.on('book.heartbeat', (event: { instrument: string }) => {
    if (event?.instrument === instrument && !request && now() >= nextAt) load();
  });

  return {
    refresh: load,
    stop() {
      stopped = true;
      cancel();
    },
  };
}
