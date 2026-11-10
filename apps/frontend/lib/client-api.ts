import { SESSION_HEADER, boundSession } from './session-binding';

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

export async function checkedFetch(path: string, init?: RequestInit) {
  // Проксі звіряє користувача з cookie, тож вкладка зі старим сокетом не подає заявки з чужого рахунку.
  const headers = new Headers(init?.headers);
  const user = boundSession();
  if (user && !headers.has(SESSION_HEADER) && /^\/api\/(?:engine|settlement)\//.test(path)) {
    headers.set(SESSION_HEADER, user);
  }
  const response = await fetch(path, { cache: 'no-store', ...init, headers });
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
