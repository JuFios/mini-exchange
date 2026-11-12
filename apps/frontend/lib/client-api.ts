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

export async function checkedFetch(path: string, init?: RequestInit) {
  // Проксі звіряє користувача з cookie, тож вкладка зі старим сокетом не подає заявки з чужого рахунку.
  const headers = new Headers(init?.headers);
  const user = boundSession();
  if (user && !headers.has(SESSION_HEADER) && /^\/api\/(?:engine|settlement)\//.test(path)) {
    headers.set(SESSION_HEADER, user);
  }
  // Запит із signal можна обірвати, тож сесію під час нього middleware не оновлює.
  const deferred = Boolean(init?.signal);
  if (deferred) headers.set(DEFER_REFRESH_HEADER, '1');
  const send = () => fetch(path, { cache: 'no-store', ...init, headers });
  let response = await send();
  if (response.status === 401 && deferred) {
    const refreshed = await refreshSession();
    if (refreshed >= 200 && refreshed < 300) response = await send();
    // Збій оновлення не означає, що сесії немає: без переходу на /login.
    else if (refreshed !== 401) throw new ApiError(refreshed, 'Не вдалося виконати запит');
  }
  if (!response.ok) {
    // Сесія завершилась: перенаправлення швидше за «з'єднання недоступне».
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
