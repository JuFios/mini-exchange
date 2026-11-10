'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BookPanel, ConnectionBadge, TradesPanel } from '../../components/market-tables';
import { type Instrument, type PickedLevel, OrderForm } from '../../components/order-form';
import { OrdersPanel, WalletPanel } from '../../components/account-panels';
import { useMarketSocket } from '../../../lib/use-market-socket';
import { type usePrivateSocket } from '../../../lib/use-private-socket';
import { useExchange } from '../shell';

type Account = ReturnType<typeof usePrivateSocket>;

function InstrumentNav({ instruments, symbol }: { instruments: Instrument[]; symbol?: string }) {
  return (
    <nav className="instruments" aria-label="Інструменти">
      {instruments.map(({ symbol: name, quoteAsset }) => (
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
  );
}

// Ринкові дані належать одному інструменту й живуть разом із сегментом `[instrument]`.
// Рахунок і приватне з'єднання лежать у layout і при перемиканні не перепідключаються.
function Market({
  instrument,
  instruments,
  wsUrl,
  account,
}: {
  instrument: Instrument;
  instruments: Instrument[];
  wsUrl: string;
  account: Account;
}) {
  const { symbol } = instrument;
  const market = useMarketSocket(wsUrl, symbol);
  const [picked, setPicked] = useState<PickedLevel>();

  return (
    <>
      <div className="market-header">
        <div>
          <p className="eyebrow">СПОТОВИЙ РИНОК</p>
          <h1>
            {instrument.baseAsset}
            <span className="market-slash">/</span>
            <span className="quote">{instrument.quoteAsset}</span>
          </h1>
        </div>
        <div className="market-nav">
          <InstrumentNav instruments={instruments} symbol={symbol} />
          <ConnectionBadge status={market.status} />
        </div>
      </div>
      <div className="terminal-grid">
        <BookPanel
          book={market.book}
          status={market.status}
          base={instrument.baseAsset}
          quote={instrument.quoteAsset}
          onPick={(price, side) =>
            setPicked((last) => ({ price, side, nonce: (last?.nonce ?? 0) + 1 }))
          }
        />
        <TradesPanel trades={market.trades} status={market.tradeStatus} error={market.tradeError} />
        <aside className="account-rail" aria-label="Торгівля та баланси">
          <OrderForm
            instrument={instrument}
            orders={account.orders}
            wallets={account.wallets}
            picked={picked}
            onOrder={account.updateOrder}
          />
          <WalletPanel wallets={account.wallets} loading={account.status === 'loading'} />
        </aside>
        <OrdersPanel
          orders={account.orders.filter(({ instrument }) => instrument === symbol)}
          loading={account.status === 'loading'}
          updateOrder={account.updateOrder}
        />
      </div>
    </>
  );
}

export function Exchange({ symbol }: { symbol: string }) {
  const { config, error, account } = useExchange();
  const instrument = config?.instruments.find(({ symbol: name }) => name === symbol);

  useEffect(() => {
    document.title = `${symbol} · Mini Exchange`;
  }, [symbol]);

  if (!instrument) {
    return (
      <>
        <div className="market-header">
          <div>
            <p className="eyebrow">СПОТОВИЙ РИНОК</p>
            <h1>Торгівля</h1>
          </div>
          <div className="market-nav">
            {config && <InstrumentNav instruments={config.instruments} />}
          </div>
        </div>
        {error && (
          <>
            <p className="message error" role="alert">
              {error}
            </p>
            {/* Layout не перемонтовується, тож невдале завантаження конфігу повторює лише перезавантаження. */}
            <button type="button" className="secondary" onClick={() => window.location.reload()}>
              Спробувати ще раз
            </button>
          </>
        )}
        {!error && !config && (
          <p className="panel empty" role="status">
            Завантажуємо інструменти…
          </p>
        )}
        {config && <p className="panel empty">Інструмент не знайдено</p>}
      </>
    );
  }

  return (
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
      <Market
        instrument={instrument}
        instruments={config!.instruments}
        wsUrl={config!.wsUrl}
        account={account}
      />
    </>
  );
}
