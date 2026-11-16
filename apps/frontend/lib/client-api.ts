import { DEFER_REFRESH_HEADER, SESSION_HEADER, boundSession } from './session-binding';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Помилка входу також має статус 401, але лишається на сторінці з формою.
const ANONYMOUS_PATH = /^\/api\/auth\/(?:login|register|logout)$/;

let refreshing: Promise<number> | undefined;

// Один запит на всі читання, що одночасно отримали 401. Без signal: обрив читання не має
// забрати відповідь із новими cookie.
function refreshSession() {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', cache: 'no-store' })
    .then((response) => response.status)
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

async function waitForRefresh(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    // Читання відмовляє вчасно; спільна ротація все ще може доставити cookie.
    return await Promise.race([refreshSession(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * Відновлення після 401 у перевірці на сервері: той самий запит оновлення, що й для читань.
 * 401 від оновлення веде на /login, тимчасовий збій сесію не завершує. Поки JWT далеко від `exp`,
 * оновлення відповідає 204 і для відкликаної сесії: тоді на /login веде повторна перевірка сторінки.
 */
export async function recoverSession(): Promise<'refreshed' | 'signed-out' | 'failed'> {
  const status = await refreshSession().catch(() => 0);
  if (status >= 200 && status < 300) return 'refreshed';
  if (status !== 401) return 'failed';
  window.location.assign('/login');
  return 'signed-out';
}

export async function checkedFetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const user = boundSession();
  if (user && !headers.has(SESSION_HEADER) && /^\/api\/(?:engine|settlement)\//.test(path)) {
    headers.set(SESSION_HEADER, user);
  }
  const deferred = Boolean(init?.signal);
  if (deferred) headers.set(DEFER_REFRESH_HEADER, '1');
  const send = () => fetch(path, { cache: 'no-store', ...init, headers });
  let response = await send();
  if (response.status === 401 && init?.signal) {
    const refreshed = await waitForRefresh(init.signal);
    if (refreshed >= 200 && refreshed < 300) response = await send();
    else if (refreshed !== 401) throw new ApiError(refreshed, 'Не вдалося виконати запит');
  }
  if (!response.ok) {
    if (response.status === 401 && !ANONYMOUS_PATH.test(path) && typeof window !== 'undefined') {
      window.location.assign('/login');
    }
    const body = await response.json().catch(() => null);
    if (body?.code === 'session_changed' && typeof window !== 'undefined') {
      window.location.reload();
    }
    const message = body?.message;
    throw new ApiError(
      response.status,
      typeof message === 'string'
        ? message
        : Array.isArray(message)
          ? message.filter((item) => typeof item === 'string').join('. ')
          : 'Не вдалося виконати запит',
    );
  }
  return response;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await checkedFetch(path, init)).json();
}

export const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : 'З’єднання тимчасово недоступне';
