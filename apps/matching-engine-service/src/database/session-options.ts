// Спільні таймаути сесій engine: пул TypeORM і окреме LISTEN-з’єднання мають збігатися.
export const PG_SESSION_OPTIONS =
  '-c idle_in_transaction_session_timeout=2000 -c statement_timeout=5000';

// Виявляє розрив лише на сокеті без незавершених запитів, наприклад на LISTEN під час простою.
// Запит у мертву мережу keepalive не обмежує: для нього є сторожовий таймер worker.
export const PG_KEEPALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 5000 };
