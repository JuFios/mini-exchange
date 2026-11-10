import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE, claims } from '../../../lib/session';
import { AdminStatus } from './status';

export default function AdminStatusPage() {
  const user = claims(cookies().get(ACCESS_COOKIE)?.value)?.sub;
  if (!user) redirect('/login');
  return <AdminStatus user={user} />;
}
