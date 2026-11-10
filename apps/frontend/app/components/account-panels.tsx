'use client';

import { useState } from 'react';
import { apiJson, errorMessage } from '../../lib/client-api';
import { type Order, type Wallet, activeOrder } from '../../lib/private-state';
import { quantityText, timeText } from './market-tables';

const labels: Record<Order['status'], string> = {
  pending: 'Очікує',
  open: 'Відкрита',
  partially_filled: 'Частково виконана',
  filled: 'Виконана',
  cancelled: 'Скасована',
};

export function WalletPanel({ wallets, loading }: { wallets: Wallet[]; loading: boolean }) {
  return (
    <section className="panel wallets">
      <div className="panel-title">
        <h2>Баланси</h2>
        <span className="tag">АКТИВИ</span>
      </div>
      {wallets.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Актив</th>
              <th scope="col">Доступно</th>
              <th scope="col">У резерві</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map(({ asset, available, reserved }) => (
              <tr key={asset}>
                <td>
                  <span className="asset">{asset}</span>
                </td>
                <td>{quantityText(available)}</td>
                <td className="muted">{quantityText(reserved)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">{loading ? 'Завантажуємо баланси…' : 'Балансів ще немає'}</p>
      )}
    </section>
  );
}

export function OrdersPanel({
  orders,
  loading,
  updateOrder,
}: {
  orders: Order[];
  loading: boolean;
  updateOrder: (order: Order) => void;
}) {
  const [tab, setTab] = useState<'active' | 'filled'>('active');
  const [cancelling, setCancelling] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const active = orders.filter(activeOrder);
  const filled = orders.filter(({ status }) => status === 'filled');
  const rows = [...(tab === 'active' ? active : filled)].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  async function cancel(order: Order) {
    setMessage('');
    setFailed(false);
    setCancelling((ids) => [...ids, order.id]);
    try {
      const result = await apiJson<{ order?: Order }>(
        '/api/engine/orders/' + encodeURIComponent(order.id),
        { method: 'DELETE' },
      );
      if (result.order) updateOrder(result.order);
      setMessage(
        result.order ? 'Заявку скасовано.' : 'Скасування прийнято. Очікуємо підтвердження.',
      );
    } catch (error) {
      setFailed(true);
      setMessage(errorMessage(error));
    } finally {
      setCancelling((ids) => ids.filter((id) => id !== order.id));
    }
  }

  return (
    <section className="panel own-orders">
      <div className="panel-title order-heading">
        <h2>Мої заявки</h2>
        <div className="order-tabs" aria-label="Статус заявок">
          <button type="button" aria-pressed={tab === 'active'} onClick={() => setTab('active')}>
            Активні <span>{active.length}</span>
          </button>
          <button type="button" aria-pressed={tab === 'filled'} onClick={() => setTab('filled')}>
            Виконані <span>{filled.length}</span>
          </button>
        </div>
      </div>
      {message && (
        <p className={`message ${failed ? 'error' : 'success'}`} role={failed ? 'alert' : 'status'}>
          {message}
        </p>
      )}
      {rows.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Час · UTC</th>
                <th scope="col">Сторона</th>
                <th scope="col">Ціна</th>
                <th scope="col">Залишок</th>
                <th scope="col">Виконано</th>
                <th scope="col">Статус</th>
                {tab === 'active' && <th scope="col">Дія</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr key={order.id}>
                  <td className="muted">
                    <time dateTime={order.createdAt}>{timeText(order.createdAt)}</time>
                  </td>
                  <td className={order.side}>{order.side === 'buy' ? 'Купівля' : 'Продаж'}</td>
                  <td>{order.price}</td>
                  <td>{quantityText(order.remainingQuantity)}</td>
                  <td>{quantityText(order.filledQuantity)}</td>
                  <td>
                    <span className="status-label">{labels[order.status]}</span>
                  </td>
                  {tab === 'active' && (
                    <td>
                      <button
                        className="secondary small"
                        type="button"
                        disabled={cancelling.includes(order.id)}
                        onClick={() => void cancel(order)}
                      >
                        Скасувати
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">
          {loading
            ? 'Завантажуємо заявки…'
            : tab === 'active'
              ? 'Активних заявок немає'
              : 'Виконаних заявок немає'}
        </p>
      )}
    </section>
  );
}
