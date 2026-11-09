import { BadGatewayException } from '@nestjs/common';

const REQUEST_TIMEOUT_MS = 10_000;

/** Внутрішній виклик engine з токеном і дедлайном; будь-яка відмова — 502, а не порожній звіт. */
export async function engineCall<T>(
  what: string,
  url: URL,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      headers: { ...init.headers, 'x-internal-token': token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    throw new BadGatewayException(`Engine ${what} are unavailable: ${(error as Error).message}`);
  }
}
