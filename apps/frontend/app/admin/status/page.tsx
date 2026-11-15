import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminAccess, adminView } from '../../../lib/admin-access';
import { clientAddress } from '../../../lib/client-address';
import { ACCESS_COOKIE, claims } from '../../../lib/session';
import { AdminDenied } from './denied';
import { DropRecoveredMarker } from './drop-recovered-marker';
import { SessionRecovery } from './session-recovery';
import { AdminStatus } from './status';

export default async function AdminStatusPage({
  searchParams,
}: {
  searchParams: { recovered?: string };
}) {
  const accessToken = cookies().get(ACCESS_COOKIE)?.value;
  const user = claims(accessToken)?.sub;
  if (!user) redirect('/login');
  // Роль у claims лишається до `exp`; поточний ADMIN_EMAILS знає engine.
  const view = adminView(
    await adminAccess(accessToken, clientAddress()),
    searchParams.recovered === '1',
  );
  if (view === 'login') redirect('/login');
  if (view === 'recover') return <SessionRecovery />;
  return (
    <>
      <DropRecoveredMarker />
      {view === 'denied' ? (
        <AdminDenied />
      ) : (
        <AdminStatus
          user={user}
          notice={
            view === 'unverified'
              ? 'Не вдалося перевірити роль адміністратора: engine не відповів або відповів помилкою. Дані сторінки можуть бути недоступні.'
              : undefined
          }
        />
      )}
    </>
  );
}
