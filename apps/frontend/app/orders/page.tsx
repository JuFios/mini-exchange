'use client';

import { useState } from 'react';

export default function OrdersPage() {
  const [instrument, setInstrument] = useState('ABC');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [result, setResult] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrument,
          side,
          price,
          quantity,
        }),
      });
      if (!res.ok) throw new Error('Не вдалося подати заявку');
      const { order, trades } = await res.json();
      setResult(
        order.status === 'pending'
          ? `Заявку ${order.id} прийнято. Очікує виконання.`
          : `Заявку прийнято. Стан: ${order.status}. Угод: ${trades.length}`,
      );
    } catch (err) {
      setResult((err as Error).message);
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '60px auto' }}>
      <h1>Подати заявку</h1>
      <form onSubmit={onSubmit}>
        <input
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
          placeholder="Інструмент"
        />
        <br />
        <select value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <br />
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Ціна" />
        <br />
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="Кількість"
        />
        <br />
        <button type="submit">Подати</button>
      </form>
      {result && <p>{result}</p>}
    </main>
  );
}
