import { type BookState, type BookStatus, type Level } from '../../lib/book-session';
import { type Trade } from '../../lib/use-market-socket';

const statusLabel: Record<BookStatus, string> = {
  loading: 'Завантаження',
  live: 'Наживо',
  reconnecting: 'Перепідключення',
  stale: 'Синхронізація',
  error: 'Помилка',
};

export function ConnectionBadge({ status }: { status: BookStatus }) {
  return (
    <span className={`connection ${status}`} role="status" data-status={status}>
      <i aria-hidden="true" />
      {statusLabel[status]}
    </span>
  );
}

export const quantityText = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
export const timeText = (value: string) => value.slice(11, 19);

function Levels({
  levels,
  side,
  quote,
  base,
  onPick,
}: {
  levels: Level[];
  side: 'buy' | 'sell';
  quote: string;
  base: string;
  onPick?: (price: string, side: 'buy' | 'sell') => void;
}) {
  const highest = Math.max(0, ...levels.map(({ quantity }) => Number(quantity)));
  return (
    <div className="levels">
      <div className={`book-side ${side}`}>{side === 'sell' ? 'Продаж' : 'Купівля'}</div>
      <table>
        <thead>
          <tr>
            <th scope="col">Ціна · {quote}</th>
            <th scope="col">Обсяг · {base}</th>
            <th scope="col" title="Кількість заявок">
              К-сть
            </th>
          </tr>
        </thead>
        <tbody>
          {levels.map(({ price, quantity, orders }) => (
            <tr
              key={price}
              className={onPick ? 'pickable' : undefined}
              onClick={() => onPick?.(price, side === 'buy' ? 'sell' : 'buy')}
            >
              <td className={side}>
                {onPick ? (
                  <button
                    type="button"
                    className="level-price"
                    title={side === 'buy' ? 'Продати за цією ціною' : 'Купити за цією ціною'}
                  >
                    {price}
                  </button>
                ) : (
                  price
                )}
              </td>
              <td className="level-quantity">
                <span
                  className={`level-fill ${side}`}
                  aria-hidden="true"
                  style={{ width: highest > 0 ? `${(100 * Number(quantity)) / highest}%` : 0 }}
                />
                <span>{quantityText(quantity)}</span>
              </td>
              <td className="muted">{orders}</td>
            </tr>
          ))}
          {!levels.length && (
            <tr>
              <td colSpan={3} className="empty">
                Немає заявок
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Ціни мають два знаки, тож різницю точно рахують сотими частками.
function spread(book: BookState) {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (!bid || !ask) return;
  const cents = Math.round(Number(ask) * 100) - Math.round(Number(bid) * 100);
  return cents < 0 ? undefined : (cents / 100).toFixed(2);
}

export function BookPanel({
  book,
  status,
  base,
  quote,
  onPick,
}: {
  book?: BookState;
  status: BookStatus;
  base: string;
  quote: string;
  onPick?: (price: string, side: 'buy' | 'sell') => void;
}) {
  const gap = book && spread(book);
  return (
    <section className="panel book">
      <div className="panel-title">
        <h2>Книга заявок</h2>
        <div className="title-tags">
          {gap !== undefined && (
            <span className="tag numeric" title="Різниця між кращими цінами продажу й купівлі">
              СПРЕД {gap}
            </span>
          )}
          {book && <span className="tag numeric">SEQ {book.seq}</span>}
        </div>
      </div>
      {status === 'error' && (
        <p className="message error" role="alert">
          Не вдалося оновити книгу. Перезавантажте сторінку.
        </p>
      )}
      {!book && status !== 'error' && <p className="empty">Очікуємо знімок книги…</p>}
      {book && (
        <div className={`book-grid ${status === 'live' ? '' : 'dimmed'}`}>
          <Levels levels={book.bids} side="buy" base={base} quote={quote} onPick={onPick} />
          <Levels levels={book.asks} side="sell" base={base} quote={quote} onPick={onPick} />
        </div>
      )}
    </section>
  );
}

export function TradesPanel({
  trades,
  status,
  error,
}: {
  trades: Trade[];
  status: 'loading' | 'ready' | 'error';
  error: string;
}) {
  return (
    <section className="panel trades">
      <div className="panel-title">
        <h2>Останні угоди</h2>
        <span className="tag">UTC</span>
      </div>
      {status === 'error' && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {trades.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Ціна</th>
                <th scope="col">Обсяг</th>
                <th scope="col">Час</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.tradeId}>
                  <td
                    className={trade.takerSide}
                    title={trade.takerSide === 'buy' ? 'Купівля' : 'Продаж'}
                  >
                    {trade.price}
                  </td>
                  <td>{quantityText(trade.quantity)}</td>
                  <td className="muted">
                    <time dateTime={trade.executedAt}>{timeText(trade.executedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        status !== 'error' && (
          <p className="empty">{status === 'loading' ? 'Завантажуємо угоди…' : 'Угод ще немає'}</p>
        )
      )}
    </section>
  );
}
