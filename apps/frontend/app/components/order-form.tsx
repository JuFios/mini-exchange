'use client';

import { type FormEvent, useState } from 'react';
import { apiJson, ApiError, errorMessage } from '../../lib/client-api';
import {
  type AmountErrors,
  type AmountLimits,
  type OrderInput,
  submitValidatedOrder,
} from '../../lib/decimal';
import { type Order, attemptKey, projectOrder } from '../../lib/private-state';

export interface Instrument extends AmountLimits {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

async function sendOrder(input: OrderInput) {
  const key = attemptKey(input);
  const pending = JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
    idempotencyKey: string;
    orderId?: string;
  } | null;
  const idempotencyKey = pending?.idempotencyKey ?? crypto.randomUUID();
  sessionStorage.setItem(key, JSON.stringify({ ...pending, idempotencyKey }));
  try {
    const { order } = await apiJson<{ order: Order }>('/api/engine/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    });
    const result = projectOrder(order);
    if (result.status === 'pending')
      sessionStorage.setItem(key, JSON.stringify({ idempotencyKey, orderId: result.id }));
    else sessionStorage.removeItem(key);
    return result;
  } catch (error) {
    // Після обриву або відповіді шлюзу наступний запит має знайти ту саму заявку.
    if (error instanceof ApiError && [400, 409, 422].includes(error.status))
      sessionStorage.removeItem(key);
    throw error;
  }
}

export function OrderForm({
  instrument,
  onOrder,
}: {
  instrument: Instrument;
  onOrder: (order: Order) => void;
}) {
  const [side, setSide] = useState<OrderInput['side']>('buy');
  const [errors, setErrors] = useState<AmountErrors>({});
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setMessage('');
    setFailed(false);
    setBusy(true);
    try {
      const { errors, result } = await submitValidatedOrder(
        {
          instrument: instrument.symbol,
          side,
          price: String(data.get('price')),
          quantity: String(data.get('quantity')),
        },
        instrument,
        sendOrder,
      );
      setErrors(errors);
      if (!result) return;
      onOrder(result);
      setMessage(
        result.status === 'pending'
          ? 'Заявку прийнято. Очікуємо виконання команди.'
          : 'Заявку оброблено.',
      );
      form.reset();
    } catch (error) {
      setFailed(true);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel ticket">
      <div className="panel-title">
        <h2>Нова заявка</h2>
        <span className="tag">ЛІМІТНА</span>
      </div>
      <form onSubmit={submit} noValidate>
        <div className="segmented" aria-label="Сторона заявки">
          <button
            type="button"
            aria-pressed={side === 'buy'}
            className="buy"
            onClick={() => setSide('buy')}
          >
            Купівля
          </button>
          <button
            type="button"
            aria-pressed={side === 'sell'}
            className="sell"
            onClick={() => setSide('sell')}
          >
            Продаж
          </button>
        </div>
        <label htmlFor="price">Ціна</label>
        <div className="unit-field">
          <input
            id="price"
            name="price"
            placeholder="0.00"
            inputMode="decimal"
            autoComplete="off"
            maxLength={10}
            aria-invalid={Boolean(errors.price)}
            aria-describedby={errors.price ? 'price-error' : undefined}
          />
          <span>{instrument.quoteAsset}</span>
        </div>
        {errors.price && (
          <p id="price-error" className="field-error" role="alert">
            {errors.price}
          </p>
        )}
        <label htmlFor="quantity">Кількість</label>
        <div className="unit-field">
          <input
            id="quantity"
            name="quantity"
            placeholder="0.00000000"
            inputMode="decimal"
            autoComplete="off"
            maxLength={16}
            aria-invalid={Boolean(errors.quantity)}
            aria-describedby={errors.quantity ? 'quantity-error' : undefined}
          />
          <span>{instrument.baseAsset}</span>
        </div>
        {errors.quantity && (
          <p id="quantity-error" className="field-error" role="alert">
            {errors.quantity}
          </p>
        )}
        <button type="submit" className={`action ${side}`} disabled={busy}>
          {busy ? 'Надсилаємо…' : 'Подати заявку'}
        </button>
        {message && (
          <p
            role={failed ? 'alert' : 'status'}
            className={`message ${failed ? 'error' : 'success'}`}
          >
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
