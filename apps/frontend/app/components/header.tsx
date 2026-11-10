'use client';

import Link from 'next/link';
import { useState } from 'react';
import { checkedFetch, errorMessage } from '../../lib/client-api';
import { announceSessionChange } from '../../lib/session-binding';
import { Brand } from './brand';

export function Header({ admin, page }: { admin: boolean; page: 'trade' | 'status' }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function logout() {
    setError('');
    setBusy(true);
    try {
      await checkedFetch('/api/auth/logout', { method: 'POST' });
      announceSessionChange();
      window.location.assign('/login');
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        {admin && (
          <nav aria-label="Основна навігація">
            <Link aria-current={page === 'trade' ? 'page' : undefined} href="/exchange/ABC">
              Торгівля
            </Link>
            <Link aria-current={page === 'status' ? 'page' : undefined} href="/admin/status">
              Стан системи
            </Link>
          </nav>
        )}
        <button type="button" className="secondary logout" disabled={busy} onClick={logout}>
          Вийти
        </button>
      </div>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
