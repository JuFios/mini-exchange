'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface Level {
  price: string;
  quantity: string;
}

interface BookState {
  bids: Level[];
  asks: Level[];
}

const INSTRUMENT = 'ABC';
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 2000;

// NOTE (стартовий код): підписка на WebSocket без обробки номера
// послідовності — якщо з'єднання розірветься й перепідключиться, клієнт
// просто продовжує з тим, що прийде далі, не звіряючи, чи не пропустив
// оновлення. Дивись ТЗ.
export default function OrderBookPage() {
  const [book, setBook] = useState<BookState>({ bids: [], asks: [] });
  const [status, setStatus] = useState<'connecting' | 'live' | 'disconnected'>('connecting');

  useEffect(() => {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';
    const socket: Socket = io(wsUrl, { transports: ['websocket'] });
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_MIN_MS;

    // Після розриву сервером чи відмови на handshake Socket.IO сам не підключається: потрібен
    // явний connect(). Затримка зростає, щоб відмовлена репліка не отримувала шквал спроб.
    const reconnect = () => {
      clearTimeout(retry);
      retry = setTimeout(() => socket.connect(), delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };

    socket.on('connect', () => {
      delay = RETRY_MIN_MS;
      setStatus('live');
      socket.emit('subscribe', INSTRUMENT);
    });
    socket.on('book', (data: BookState) => setBook(data));
    socket.on('disconnect', (reason) => {
      setStatus('disconnected');
      if (reason === 'io server disconnect') reconnect();
    });
    socket.on('connect_error', () => {
      setStatus('disconnected');
      if (!socket.active) reconnect();
    });

    return () => {
      clearTimeout(retry);
      socket.disconnect();
    };
  }, []);

  return (
    <main style={{ maxWidth: 480, margin: '60px auto' }}>
      <h1>Order Book — {INSTRUMENT}</h1>
      <p>Статус з&apos;єднання: {status}</p>
      <div style={{ display: 'flex', gap: 32 }}>
        <div>
          <h3>Bids</h3>
          <ul>
            {book.bids.map((l, i) => (
              <li key={i}>
                {l.price} × {l.quantity}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Asks</h3>
          <ul>
            {book.asks.map((l, i) => (
              <li key={i}>
                {l.price} × {l.quantity}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
