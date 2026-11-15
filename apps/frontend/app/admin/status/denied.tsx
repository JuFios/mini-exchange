import Link from 'next/link';
import { Header } from '../../components/header';

/** Engine відповів 403: адресу вилучено з ADMIN_EMAILS, хоча claims токена досі мають роль. */
export function AdminDenied() {
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
          Сторінка доступна лише адміністратору.
        </p>
        <p>
          <Link href="/exchange/ABC">Повернутися до торгівлі</Link>
        </p>
      </main>
    </>
  );
}
