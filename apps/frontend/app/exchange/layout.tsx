import { cookies } from 'next/headers';
import { adminAccess } from '../../lib/admin-access';
import { clientAddress } from '../../lib/client-address';
import { ACCESS_COOKIE } from '../../lib/session';
import { ExchangeShell } from './shell';

// Layout не перемонтовується при зміні сегмента `[instrument]`, тож конфіг і приватне
// з'єднання переживають перемикання між інструментами.
export default async function ExchangeLayout({ children }: { children: React.ReactNode }) {
  // Посилання на «Стан системи» лише після підтвердження engine; без відповіді воно сховане.
  // Токен без ролі в claims запиту не робить.
  const access = await adminAccess(cookies().get(ACCESS_COOKIE)?.value, clientAddress());
  return <ExchangeShell admin={access === 'admin'}>{children}</ExchangeShell>;
}
