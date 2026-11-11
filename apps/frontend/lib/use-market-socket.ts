'use client';

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { type BookState, type BookStatus, startBookSession } from './book-session';
import { apiJson, errorMessage } from './client-api';
import { startTradeHistory } from './trade-history';

export interface Trade {
  tradeId: string;
  seq: string;
  price: string;
  quantity: string;
  takerSide: 'buy' | 'sell';
  executedAt: string;
}

function validTrade(trade: Trade) {
  return (
    trade &&
    typeof trade.tradeId === 'string' &&
    typeof trade.seq === 'string' &&
    /^\d+$/.test(trade.seq) &&
    typeof trade.price === 'string' &&
    typeof trade.quantity === 'string' &&
    (trade.takerSide === 'buy' || trade.takerSide === 'sell') &&
    typeof trade.executedAt === 'string'
  );
}

function tradeRows(...groups: Trade[][]) {
  const unique = new Map<string, Trade>();
  for (const rows of groups) {
    for (const { tradeId, seq, price, quantity, takerSide, executedAt } of rows) {
      if (!unique.has(tradeId))
        unique.set(tradeId, { tradeId, seq, price, quantity, takerSide, executedAt });
    }
  }
  return [...unique.values()]
    .sort((a, b) => {
      const difference = BigInt(b.seq) - BigInt(a.seq);
      return difference > 0n ? 1 : difference < 0n ? -1 : 0;
    })
    .slice(0, 50);
}

export function useMarketSocket(url: string | undefined, instrument: string) {
  const [book, setBook] = useState<BookState>();
  const [status, setStatus] = useState<BookStatus>('loading');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradeStatus, setTradeStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tradeError, setTradeError] = useState('');

  useEffect(() => {
    if (!url) return;
    const socket = io(url + '/market', { autoConnect: false, transports: ['websocket'] });
    const history = startTradeHistory(
      socket,
      instrument,
      async (signal) => {
        const rows = await apiJson<Trade[]>(
          `/api/engine/instruments/${encodeURIComponent(instrument)}/trades?limit=50`,
          { signal },
        );
        if (!Array.isArray(rows) || !rows.every(validTrade))
          throw new Error('Invalid trade snapshot');
        return rows;
      },
      {
        onRows(rows) {
          setTrades((current) => tradeRows(rows, current));
          setTradeStatus('ready');
          setTradeError('');
        },
        onError(error) {
          setTradeStatus('error');
          setTradeError(errorMessage(error));
        },
      },
    );
    const stop = startBookSession(socket, instrument, {
      onBook: setBook,
      onStatus: setStatus,
      onSnapshot: history.refresh,
    });
    socket.on('trade', (trade: Trade & { instrument: string }) => {
      if (trade?.instrument !== instrument) return;
      if (!validTrade(trade)) {
        setTradeStatus('error');
        setTradeError('Отримано некоректну подію угоди');
        return;
      }
      setTrades((current) => tradeRows([trade], current));
    });
    socket.connect();
    return () => {
      history.stop();
      stop();
    };
  }, [url, instrument]);

  return { book, status, trades, tradeStatus, tradeError };
}
