# Mini Exchange — стартовий репозиторій

Це стартовий каркас для тестового завдання (`ТЗ_тестове_завдання_7`). Частина
компонентів уже працює, частина — лише каркас або TODO. Повний опис завдання
— у файлі ТЗ, який ви отримали окремо.

## Що вже працює

- `apps/matching-engine-service` — автентифікація, подача/скасування заявок,
  зіставлення за price-time priority, self-trade prevention, трансляція
  order book через WebSocket.
- `apps/frontend` — форма подачі заявки і сторінка order book з live-оновленням.

## Що ще НЕ реалізовано / потребує уваги

- `apps/settlement-service` — лише каркас, розрахунок угод не реалізовано
  (`NotImplementedException`).
- Розподілена координація "один власник order book на інструмент" —
  `RedisLockService` існує, але ще ніде не підключений.
- Публікація угод у чергу подій (зараз `OrdersService.submitOrder` лише
  повертає угоди виклику, нікуди їх не публікуючи).
- Обробка розриву WebSocket-з'єднання на фронтенді (resync за номером
  послідовності).

## Запуск

```bash
docker-compose up --build
```

- matching-engine-service: http://localhost:3001
- settlement-service: http://localhost:3002
- frontend: http://localhost:3000

## Тести

```bash
cd apps/matching-engine-service && npm test
```

Не всі тести в репозиторії однаково надійні — це навмисно, дивись ТЗ.
