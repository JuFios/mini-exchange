'use client';

import { useState } from 'react';
import { apiJson, errorMessage } from '../../lib/client-api';
import { type Order, type Wallet, activeOrder, cancelNotice } from '../../lib/private-state';
import { quantityText, timeText } from './market-tables';

const labels: Record<Order['status'], string> = {
  pending: 'Очікує',
  open: 'Відкрита',
  partially_filled: 'Частково виконана',
  filled: 'Виконана',
  cancelled: 'Скасована',
};

const reasons: Record<string, string> = {
  self_trade_prevented: 'Скасовано, щоб уникнути угоди з власною заявкою',
  rejected: 'Заявку відхилено',
};

const reason = ({ cancelReason }: Order) => (cancelReason ? reasons[cancelReason] : undefined);

type Tab = 'active' | 'filled' | 'cancelled';
const emptyText: Record<Tab, string> = {
  active: 'Активних заявок немає',
  filled: 'Виконаних заявок немає',
  cancelled: 'Скасованих заявок немає',
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
  const [tab, setTab] = useState<Tab>('active');
  const [cancelling, setCancelling] = useState<string[]>([]);
  // Підтверджене скасування показує поточний стан заявки, помилка — власний текст.
  const [notice, setNotice] = useState<{ orderId: string } | { error: string }>();
  const active = orders.filter(activeOrder);
  const filled = orders.filter(({ status }) => status === 'filled');
  const cancelled = orders.filter(({ status }) => status === 'cancelled');
  const rows = [...{ active, filled, cancelled }[tab]].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  const shown = !notice
    ? undefined
    : 'error' in notice
      ? { message: notice.error, failed: true }
      : cancelNotice(orders.find(({ id }) => id === notice.orderId));

  async function cancel(order: Order) {
    setNotice(undefined);
    setCancelling((ids) => [...ids, order.id]);
    try {
      const result = await apiJson<{ order?: Order }>(
        '/api/engine/orders/' + encodeURIComponent(order.id),
        { method: 'DELETE' },
      );
      if (result.order) updateOrder(result.order);
      setNotice({ orderId: order.id });
    } catch (error) {
      setNotice({ error: errorMessage(error) });
    } finally {
      setCancelling((ids) => ids.filter((id) => id !== order.id));
    }
  }

  return (
    <section className="panel own-orders">
      <div className="panel-title order-heading">
        <h2>Мої заявки</h2>
        <div className="order-tabs" role="group" aria-label="Статус заявок">
          {(
            [
              ['active', 'Активні', active.length],
              ['filled', 'Виконані', filled.length],
              ['cancelled', 'Скасовані', cancelled.length],
            ] as const
          ).map(([name, label, count]) => (
            <button
              key={name}
              type="button"
              aria-pressed={tab === name}
              onClick={() => {
                setTab(name);
                setNotice(undefined);
              }}
            >
              {label} <span>{count}</span>
            </button>
          ))}
        </div>
      </div>
      {shown && (
        <p
          className={`message ${shown.failed ? 'error' : 'success'}`}
          role={shown.failed ? 'alert' : 'status'}
        >
          {shown.message}
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
                <th scope="col">{tab === 'cancelled' ? 'Скасовано' : 'Залишок'}</th>
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
                    <span className="status-label" title={reason(order)}>
                      {labels[order.status]}
                      {reason(order) && <span className="visually-hidden"> · {reason(order)}</span>}
                    </span>
                  </td>
                  {tab === 'active' && (
                    <td>
                      <button
                        className="secondary small"
                        type="button"
                        disabled={cancelling.includes(order.id)}
                        onClick={() => void cancel(order)}
                      >
                        {cancelling.includes(order.id) ? 'Скасовуємо…' : 'Скасувати'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">{loading ? 'Завантажуємо заявки…' : emptyText[tab]}</p>
      )}
    </section>
  );
}
