import { backendUrl, frontendProxyToken } from './api';
import { claims } from './session';

// Сторінка не має чекати engine довше за звичайну навігацію; без відповіді роль невідома.
const ADMIN_CHECK_TIMEOUT_MS = 1500;

export type AdminAccess = 'admin' | 'forbidden' | 'unauthenticated' | 'unknown';

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
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    'x-frontend-proxy': frontendProxyToken(),
  });
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
    if (response.status === 403) return 'forbidden';
    // 401 — сесію відкликано або токен сплив після middleware: її треба оновити, а не чекати.
    return response.status === 401 ? 'unauthenticated' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export type AdminView = 'status' | 'unverified' | 'denied' | 'recover' | 'login';

/**
 * Що показати на «Стан системи». Без відповіді engine сторінка відкривається з попередженням: її
 * дані backend віддає лише адміну, а під час збою engine вона й потрібна. 401 оновлює сесію
 * один раз (`recovered` — сторінку вже перезавантажено після оновлення), далі — новий вхід.
 */
export function adminView(access: AdminAccess, recovered: boolean): AdminView {
  if (access === 'admin') return 'status';
  if (access === 'unknown') return 'unverified';
  if (access === 'forbidden') return 'denied';
  return recovered ? 'login' : 'recover';
}
