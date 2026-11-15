import { backendUrl } from './api';
import { claims } from './session';

// Сторінка не має чекати engine довше за звичайну навігацію; без відповіді роль невідома.
const ADMIN_CHECK_TIMEOUT_MS = 1500;

export type AdminAccess = 'admin' | 'forbidden' | 'unknown';

/**
 * Роль у claims лише показує, що токен видано адміну; поточний `ADMIN_EMAILS` знає engine.
 * Токен без ролі в claims engine теж не визнає адміном, тож запиту для нього немає.
 */
export async function adminAccess(
  accessToken: string | undefined,
  address?: string,
  timeoutMs = ADMIN_CHECK_TIMEOUT_MS,
): Promise<AdminAccess> {
  if (!claims(accessToken)?.roles?.includes('admin')) return 'forbidden';
  const headers = new Headers({ authorization: `Bearer ${accessToken}` });
  if (address) headers.set('x-forwarded-for', address);
  try {
    const response = await fetch(backendUrl('engine') + '/auth/admin', {
      headers,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    if (response.status === 204) return 'admin';
    return response.status === 401 || response.status === 403 ? 'forbidden' : 'unknown';
  } catch {
    return 'unknown';
  }
}
