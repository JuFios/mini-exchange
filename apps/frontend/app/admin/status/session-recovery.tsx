'use client';

import { useEffect, useState } from 'react';
import { Header } from '../../components/header';
import { recoverSession } from '../../../lib/client-api';

/**
 * Engine відхилив сесію (401), хоча JWT ще чинний. Сервер не може оновити cookie під час
 * рендеру, тож оновлює браузер тим самим запитом, що й читання API, і відкриває сторінку знову.
 */
export function SessionRecovery() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void recoverSession().then((result) => {
      if (!active) return;
      // Позначка зупиняє цикл: якщо після оновлення знову 401, сторінка веде на вхід.
      if (result === 'refreshed') window.location.replace('/admin/status?recovered=1');
      if (result === 'failed') setFailed(true);
    });
    return () => {
      active = false;
    };
  }, []);
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
        <p className={failed ? 'message error' : 'message pending'} role="status">
          {failed
            ? 'Не вдалося оновити сесію. Оновіть сторінку трохи пізніше.'
            : 'Оновлюємо сесію…'}
        </p>
      </main>
    </>
  );
}
