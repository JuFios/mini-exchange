import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminAccess } from '../../../lib/admin-access';
import { clientAddress } from '../../../lib/client-address';
import { ACCESS_COOKIE, claims } from '../../../lib/session';
import { AdminDenied } from './denied';
import { AdminStatus } from './status';

export default async function AdminStatusPage() {
  const accessToken = cookies().get(ACCESS_COOKIE)?.value;
  const user = claims(accessToken)?.sub;
  if (!user) redirect('/login');
  // Роль у claims лишається до `exp`; поточний ADMIN_EMAILS знає engine.
  const access = await adminAccess(accessToken, clientAddress());
  if (access !== 'admin') return <AdminDenied access={access} />;
  return <AdminStatus user={user} />;
}
