export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function checkedFetch(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: 'no-store', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
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
