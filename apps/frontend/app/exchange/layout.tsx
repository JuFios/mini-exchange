import { cookies } from 'next/headers';
import { ACCESS_COOKIE, claims } from '../../lib/session';
import { ExchangeShell } from './shell';

// Layout не перемонтовується при зміні сегмента `[instrument]`, тож конфіг і приватне
// з'єднання переживають перемикання між інструментами.
export default function ExchangeLayout({ children }: { children: React.ReactNode }) {
  const admin = claims(cookies().get(ACCESS_COOKIE)?.value)?.roles?.includes('admin') ?? false;
  return <ExchangeShell admin={admin}>{children}</ExchangeShell>;
}
