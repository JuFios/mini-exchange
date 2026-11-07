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

    socket.on('connect', () => {
      setStatus('live');
      socket.emit('subscribe', INSTRUMENT);
    });
    socket.on('book', (data: BookState) => setBook(data));
    socket.on('disconnect', () => setStatus('disconnected'));

    return () => {
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
