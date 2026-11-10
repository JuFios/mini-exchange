'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { apiJson, ApiError, errorMessage } from '../../lib/client-api';
import {
  type AmountErrors,
  type AmountLimits,
  type OrderInput,
  orderTotal,
  submitValidatedOrder,
} from '../../lib/decimal';
import {
  type Order,
  type Wallet,
  attemptKey,
  orderFeedback,
  projectOrder,
} from '../../lib/private-state';
import { quantityText } from './market-tables';

export interface Instrument extends AmountLimits {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

/** Рівень книги, який користувач вибрав кліком: підставляє ціну й сторону. */
export interface PickedLevel {
  price: string;
  side: OrderInput['side'];
  nonce: number;
}

// sessionStorage може бути недоступний (приватний режим, заблоковані дані сайту).
function readAttempt(key: string) {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
      idempotencyKey: string;
      orderId?: string;
    } | null;
  } catch {
    return null;
  }
}

function writeAttempt(key: string, value: { idempotencyKey: string; orderId?: string } | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // Без сховища повторна відправка отримає новий ключ — це лише втрата захисту від дубля.
  }
}

async function sendOrder(input: OrderInput) {
  const key = attemptKey(input);
  const pending = readAttempt(key);
  const idempotencyKey = pending?.idempotencyKey ?? crypto.randomUUID();
  writeAttempt(key, { ...pending, idempotencyKey });
  try {
    const { order } = await apiJson<{ order: Order }>('/api/engine/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    });
    const result = projectOrder(order);
    writeAttempt(key, result.status === 'pending' ? { idempotencyKey, orderId: result.id } : null);
    return result;
  } catch (error) {
    // Після обриву або відповіді шлюзу наступний запит має знайти ту саму заявку.
    if (error instanceof ApiError && [400, 409, 422].includes(error.status)) {
      writeAttempt(key, null);
    }
    throw error;
  }
}

export function OrderForm({
  instrument,
  orders,
  wallets,
  picked,
  onOrder,
}: {
  instrument: Instrument;
  orders: readonly Order[];
  wallets: readonly Wallet[];
  picked?: PickedLevel;
  onOrder: (order: Order) => void;
}) {
  const [side, setSide] = useState<OrderInput['side']>('buy');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [errors, setErrors] = useState<AmountErrors>({});
  const [submitted, setSubmitted] = useState<Order>();
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const feedback = submitted ? orderFeedback(submitted, orders) : undefined;
  const message = failure || feedback?.message;
  const failed = Boolean(failure) || feedback?.failed;
  const spendAsset = side === 'buy' ? instrument.quoteAsset : instrument.baseAsset;
  const available = wallets.find(({ asset }) => asset === spendAsset)?.available;
  const total = orderTotal(price, quantity);

  useEffect(() => {
    if (!picked) return;
    setSide(picked.side);
    setPrice(picked.price);
    setErrors((current) => ({ ...current, price: undefined }));
    dismiss();
    // Нова ціна з книги — окрема подія, тому залежимо лише від її nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.nonce]);

  // Старий результат не має висіти над полями, які вже змінили.
  function dismiss() {
    setSubmitted(undefined);
    setFailure('');
  }

  function edit(field: 'price' | 'quantity', value: string) {
    (field === 'price' ? setPrice : setQuantity)(value);
    setErrors((current) => ({ ...current, [field]: undefined }));
    dismiss();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    dismiss();
    setBusy(true);
    try {
      const { errors, result } = await submitValidatedOrder(
        { instrument: instrument.symbol, side, price, quantity },
        instrument,
        sendOrder,
      );
      setErrors(errors);
      if (!result) return;
      onOrder(result);
      setSubmitted(result);
      setPrice('');
      setQuantity('');
    } catch (error) {
      setFailure(errorMessage(error));
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
        <div className="segmented" role="group" aria-label="Сторона заявки">
          <button
            type="button"
            aria-pressed={side === 'buy'}
            className="buy"
            onClick={() => {
              setSide('buy');
              dismiss();
            }}
          >
            Купівля
          </button>
          <button
            type="button"
            aria-pressed={side === 'sell'}
            className="sell"
            onClick={() => {
              setSide('sell');
              dismiss();
            }}
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
            value={price}
            onChange={(event) => edit('price', event.target.value)}
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
            value={quantity}
            onChange={(event) => edit('quantity', event.target.value)}
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
        <dl className="ticket-facts">
          <div>
            <dt>Сума</dt>
            <dd>{total ? `${quantityText(total)} ${instrument.quoteAsset}` : '—'}</dd>
          </div>
          <div>
            <dt>Доступно</dt>
            <dd>{available === undefined ? '—' : `${quantityText(available)} ${spendAsset}`}</dd>
          </div>
        </dl>
        <button type="submit" className={`action ${side}`} disabled={busy}>
          {busy ? 'Надсилаємо…' : 'Подати заявку'}
        </button>
        <p className="visually-hidden" role="status">
          {picked &&
            `Ціну ${picked.price} підставлено, сторона: ${picked.side === 'buy' ? 'купівля' : 'продаж'}.`}
        </p>
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
