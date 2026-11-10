'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Header } from '../components/header';
import { type Instrument } from '../components/order-form';
import { apiJson, errorMessage } from '../../lib/client-api';
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
    void Promise.all([
      apiJson<{ wsUrl: string }>('/api/config', { signal }),
      apiJson<Instrument[]>('/api/engine/instruments', { signal }),
    ])
      .then(([{ wsUrl }, instruments]) => {
        if (!signal.aborted) setConfig({ wsUrl, instruments });
      })
      .catch((error: unknown) => {
        if (!signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, []);

  return (
    <ExchangeContext.Provider value={{ config, error, account }}>
      <Header admin={admin} page="trade" />
      <main className="workspace">{children}</main>
    </ExchangeContext.Provider>
  );
}
