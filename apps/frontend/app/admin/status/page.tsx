'use client';

import { useEffect, useState } from 'react';
import { Header } from '../../components/header';
import { apiJson, ApiError, errorMessage } from '../../../lib/client-api';

interface Instrument {
  instrument: string;
  status: string;
  ownerInstance: string | null;
  epoch: string;
  lastAppliedSeq: string;
  maxSeq: string;
  backlog: string;
  bestBid: string | null;
  bestAsk: string | null;
  levels: number;
  resting: string;
  outboxBacklog: string;
}

interface Queue {
  streams: { stream: string; lag: number | null; pending: number }[];
  deadLetters: number;
}

interface Report {
  period: { to: string };
  ok: boolean;
  counts: { engineTrades: number; ledgerTrades: number; matched: number; pending: number };
}

export default function AdminStatusPage() {
  const [status, setStatus] = useState<{ instruments: Instrument[]; queue: Queue }>();
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState('');
  const [reportError, setReportError] = useState('');

  useEffect(() => {
    document.title = 'Стан системи · Mini Exchange';
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const [instruments, queue] = await Promise.all([
          apiJson<Instrument[]>('/api/engine/admin/instruments', { signal }),
          apiJson<Queue>('/api/settlement/admin/queue', { signal }),
        ]);
        if (signal.aborted) return;
        setStatus({ instruments, queue });
        setError('');
      } catch (error) {
        if (!signal.aborted) setError(errorMessage(error));
      } finally {
        // Повільний запит має завершитися перед наступним опитуванням.
        if (!signal.aborted) timer = setTimeout(poll, 2000);
      }
    }

    void poll();
    void apiJson<Report>('/api/settlement/admin/reconciliation', { signal })
      .then((value) => {
        if (!signal.aborted) setReport(value);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        // 502–504 означають обрив довгої звірки або недоступний сервіс, а не відмову за правами.
        setReportError(
          error instanceof ApiError && [502, 503, 504].includes(error.status)
            ? 'Звірка триває довше за очікуване або сервіс недоступний. Оновіть сторінку пізніше.'
            : errorMessage(error),
        );
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <Header admin page="status" />
      <main className="workspace">
        <div className="market-header">
          <div>
            <p className="eyebrow">АДМІНІСТРУВАННЯ</p>
            <h1>Стан системи</h1>
          </div>
          <span className="tag">ОНОВЛЕННЯ · 2 С</span>
        </div>
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <div className="admin-grid">
          <section className="panel">
            <div className="panel-title">
              <h2>Інструменти</h2>
            </div>
            {status ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        'Інструмент',
                        'Стан',
                        'Власник',
                        'Епоха',
                        'Seq',
                        'Backlog',
                        'Bid',
                        'Ask',
                        'Рівні',
                        'Заявки',
                        'Outbox',
                      ].map((name) => (
                        <th scope="col" key={name}>
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {status.instruments.map((row) => (
                      <tr key={row.instrument}>
                        <td>
                          <span className="asset">{row.instrument}</span>
                        </td>
                        <td>{row.status}</td>
                        <td>{row.ownerInstance ?? '—'}</td>
                        <td>{row.epoch}</td>
                        <td>
                          {row.lastAppliedSeq} / {row.maxSeq}
                        </td>
                        <td>{row.backlog}</td>
                        <td className="buy">{row.bestBid ?? '—'}</td>
                        <td className="sell">{row.bestAsk ?? '—'}</td>
                        <td>{row.levels}</td>
                        <td>{row.resting}</td>
                        <td>{row.outboxBacklog}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              !error && <p className="empty">Завантажуємо стан інструментів…</p>
            )}
          </section>
          <section className="panel">
            <div className="panel-title">
              <h2>Черга розрахунків</h2>
              {status && <span className="tag">DLQ · {status.queue.deadLetters}</span>}
            </div>
            {status ? (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Stream</th>
                    <th scope="col">Lag</th>
                    <th scope="col">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {status.queue.streams.map((row) => (
                    <tr key={row.stream}>
                      <td>{row.stream}</td>
                      <td>{row.lag ?? '—'}</td>
                      <td>{row.pending}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              !error && <p className="empty">Завантажуємо чергу…</p>
            )}
          </section>
          <section className="panel">
            <div className="panel-title">
              <h2>Остання звірка</h2>
              {report && (
                <span className={`connection ${report.ok ? 'live' : 'error'}`}>
                  <i />
                  {report.ok ? 'Узгоджено' : 'Є розбіжності'}
                </span>
              )}
            </div>
            {reportError && (
              <p className="message error" role="alert">
                {reportError}
              </p>
            )}
            {report ? (
              <dl className="report">
                <div>
                  <dt>Станом на</dt>
                  <dd>
                    <time dateTime={report.period.to}>{report.period.to}</time>
                  </dd>
                </div>
                <div>
                  <dt>Угоди engine</dt>
                  <dd>{report.counts.engineTrades}</dd>
                </div>
                <div>
                  <dt>Угоди ledger</dt>
                  <dd>{report.counts.ledgerTrades}</dd>
                </div>
                <div>
                  <dt>Збіги</dt>
                  <dd>{report.counts.matched}</dd>
                </div>
                <div>
                  <dt>Очікують</dt>
                  <dd>{report.counts.pending}</dd>
                </div>
              </dl>
            ) : (
              !reportError && <p className="empty">Виконуємо звірку…</p>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
