'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { checkedFetch, errorMessage } from '../../lib/client-api';
import { announceSessionChange } from '../../lib/session-binding';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const registering = mode === 'register';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // До гідратації обробника немає, і браузер відправив би форму звичайним GET із паролем в URL.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await checkedFetch('/api/auth/' + mode, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
      });
      announceSessionChange();
      window.location.assign('/exchange/ABC');
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="panel auth-card">
        <p className="eyebrow">ОБЛІКОВИЙ ЗАПИС</p>
        <h1>{registering ? 'Створіть акаунт' : 'Вхід до біржі'}</h1>
        <p className="muted">
          {registering
            ? 'Вкажіть пошту й пароль для реєстрації.'
            : 'Введіть пошту та пароль, щоб продовжити.'}
        </p>
        <form method="post" onSubmit={submit}>
          <label htmlFor="email">Електронна пошта</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@example.com"
            required
          />
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={registering ? 'new-password' : 'current-password'}
            minLength={registering ? 8 : undefined}
            required
          />
          {registering && <p className="field-hint">Щонайменше 8 символів</p>}
          {error && (
            <p className="message error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="action" disabled={busy || !ready}>
            {busy ? 'Зачекайте…' : registering ? 'Зареєструватися' : 'Увійти'}
          </button>
        </form>
        <p className="auth-switch">
          {registering ? 'Уже є акаунт?' : 'Вперше на біржі?'}{' '}
          <Link href={registering ? '/login' : '/register'}>
            {registering ? 'Увійти' : 'Зареєструватися'}
          </Link>
        </p>
      </section>
    </main>
  );
}
