'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '../../components/header';
import { BookPanel, ConnectionBadge, TradesPanel } from '../../components/market-tables';
import { OrderForm, type Instrument } from '../../components/order-form';
import { OrdersPanel, WalletPanel } from '../../components/account-panels';
import { apiJson, errorMessage } from '../../../lib/client-api';
import { useMarketSocket } from '../../../lib/use-market-socket';
import { usePrivateSocket } from '../../../lib/use-private-socket';

export function Exchange({ symbol, admin }: { symbol: string; admin: boolean }) {
  const [config, setConfig] = useState<{ wsUrl: string; instruments: Instrument[] }>();
  const [error, setError] = useState('');
  const instrument = config?.instruments.find(({ symbol: name }) => name === symbol);
  const market = useMarketSocket(instrument ? config?.wsUrl : undefined, symbol);
  const account = usePrivateSocket(instrument ? config?.wsUrl : undefined);

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
    <>
      <Header admin={admin} page="trade" />
      <main className="workspace">
        <div className="market-header">
          <div>
            <p className="eyebrow">СПОТОВИЙ РИНОК</p>
            <h1>
              {instrument ? (
                <>
                  {instrument.baseAsset}
                  <span className="market-slash">/</span>
                  <span className="quote">{instrument.quoteAsset}</span>
                </>
              ) : (
                'Торгівля'
              )}
            </h1>
          </div>
          <div className="market-nav">
            {config && (
              <nav className="instruments" aria-label="Інструменти">
                {config.instruments.map(({ symbol: name, quoteAsset }) => (
                  <Link
                    key={name}
                    aria-current={name === symbol ? 'page' : undefined}
                    href={`/exchange/${name}`}
                  >
                    {name}
                    <span>/{quoteAsset}</span>
                  </Link>
                ))}
              </nav>
            )}
            {instrument && <ConnectionBadge status={market.status} />}
          </div>
        </div>
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        {!error && !config && (
          <p className="panel empty" role="status">
            Завантажуємо інструменти…
          </p>
        )}
        {config && !instrument && <p className="panel empty">Інструмент не знайдено</p>}
        {instrument && (
          <>
            {account.status === 'error' && (
              <p className="message error" role="alert">
                Приватні дані · {account.error}
              </p>
            )}
            {account.status === 'reconnecting' && (
              <p className="message pending" role="status">
                Відновлюємо з’єднання для заявок і балансів…
              </p>
            )}
            <div className="terminal-grid">
              <BookPanel
                book={market.book}
                status={market.status}
                base={instrument.baseAsset}
                quote={instrument.quoteAsset}
              />
              <TradesPanel
                trades={market.trades}
                status={market.tradeStatus}
                error={market.tradeError}
              />
              <aside className="account-rail" aria-label="Торгівля та баланси">
                <OrderForm instrument={instrument} onOrder={account.updateOrder} />
                <WalletPanel wallets={account.wallets} loading={account.status === 'loading'} />
              </aside>
              <OrdersPanel
                orders={account.orders.filter(({ instrument }) => instrument === symbol)}
                loading={account.status === 'loading'}
                updateOrder={account.updateOrder}
              />
            </div>
          </>
        )}
      </main>
    </>
  );
}
