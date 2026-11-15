import Link from 'next/link';
import { Header } from '../../components/header';
import type { AdminAccess } from '../../../lib/admin-access';

const messages: Record<Exclude<AdminAccess, 'admin'>, string> = {
  forbidden: 'Сторінка доступна лише адміністратору.',
  unknown: 'Не вдалося перевірити роль адміністратора. Оновіть сторінку трохи пізніше.',
};

export function AdminDenied({ access }: { access: Exclude<AdminAccess, 'admin'> }) {
  return (
    <>
      <Header admin={false} page="status" />
      <main className="workspace">
        <div className="market-header">
          <div>
            <p className="eyebrow">АДМІНІСТРУВАННЯ</p>
            <h1>Стан системи</h1>
          </div>
        </div>
        <p className="message error" role="alert">
          {messages[access]}
        </p>
        <p>
          <Link href="/exchange/ABC">Повернутися до торгівлі</Link>
        </p>
      </main>
    </>
  );
}
