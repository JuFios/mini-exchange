'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Header } from '../components/header';
import { type Instrument } from '../components/order-form';
import { ApiError, apiJson, errorMessage } from '../../lib/client-api';
import { watchSessionChange } from '../../lib/session-binding';
import { usePrivateSocket } from '../../lib/use-private-socket';

interface Config {
  wsUrl: string;
  instruments: Instrument[];
}

interface ExchangeState {
  config?: Config;
  error: string;
  account: ReturnType<typeof usePrivateSocket>;
}

const ExchangeContext = createContext<ExchangeState | undefined>(undefined);

export function useExchange() {
  const state = useContext(ExchangeContext);
  if (!state) throw new Error('useExchange must be used inside ExchangeShell');
  return state;
}

export function ExchangeShell({ admin, children }: { admin: boolean; children: React.ReactNode }) {
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState('');
  const account = usePrivateSocket(config?.wsUrl);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void Promise.all([
        apiJson<{ wsUrl: string }>('/api/config', { signal }),
        apiJson<Instrument[]>('/api/engine/instruments', { signal }),
      ])
        .then(([{ wsUrl }, instruments]) => {
          if (signal.aborted) return;
          setConfig({ wsUrl, instruments });
          setError('');
        })
        .catch((error: unknown) => {
          if (signal.aborted) return;
          setError(errorMessage(error));
          // Ingress обмежує адресу клієнта й повертає квоту щосекунди. Без повтору термінал
          // лишався б без конфігурації до перезавантаження; пауза 1–2 с розводить вкладки за NAT.
          if (error instanceof ApiError && error.status === 429) {
            retry = setTimeout(load, 1000 + Math.random() * 1000);
          }
        });
    load();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, []);

  // Вхід або вихід в іншій вкладці міняє спільні cookie: оновлюємо сторінку, щоб не показувати чужий рахунок.
  useEffect(() => watchSessionChange(() => window.location.reload()), []);

  return (
    <ExchangeContext.Provider value={{ config, error, account }}>
      <Header admin={admin} page="trade" />
      <main className="workspace">{children}</main>
    </ExchangeContext.Provider>
  );
}
