// Спільні таймаути сесій engine: пул TypeORM і окреме LISTEN-з’єднання мають збігатися.
export const PG_SESSION_OPTIONS =
  '-c idle_in_transaction_session_timeout=2000 -c statement_timeout=5000';

// Без keepalive запит на мовчазно втраченому з'єднанні чекає вічно, а renew у Redis тримає lease.
export const PG_KEEPALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 5000 };
