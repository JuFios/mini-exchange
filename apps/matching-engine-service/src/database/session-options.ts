// Спільні таймаути сесій engine: пул TypeORM і окреме LISTEN-з’єднання мають збігатися.
export const PG_SESSION_OPTIONS =
  '-c idle_in_transaction_session_timeout=2000 -c statement_timeout=5000';
