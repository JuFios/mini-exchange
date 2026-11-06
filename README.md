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
docker compose up --build
```

Якщо встановлено alias `docker-compose`, можна запустити `docker-compose up --build`.
Для запуску у фоні з очікуванням усіх healthcheck використовуйте `docker compose up -d --build --wait`.

- matching-engine-service: http://localhost:3001
- settlement-service: http://localhost:3002
- frontend: http://localhost:3000
- PostgreSQL: `127.0.0.1:5433`, Redis: `127.0.0.1:6379`

Обидва backend-сервіси повертають HTTP 200 та `{"status":"ok"}` на `GET /health`.
Це перевірка доступності HTTP-процесу. PostgreSQL і Redis мають власні healthcheck.
Redis пише AOF у том `redis-data` і працює з політикою `noeviction`.

## Знайдені проблеми

| ID | Симптом | Відтворення на `starter-baseline` | Виправлення |
|---|---|---|---|
| S-11 | Збірка або запуск Docker падають, а CI не знаходить lockfiles для npm-кешу | `docker compose up -d --build --wait`, `docker compose up -d --build --wait matching-engine-service`, `npm ci` у будь-якому з трьох пакетів, `npm install && npm run build` у `apps/frontend` | Lockfiles, окремі налаштування збірки Nest, явний `varchar` для `User.refreshTokenHash`, екранування апострофа в JSX і `.dockerignore` для залежностей та артефактів хоста. CI встановлює залежності через `npm ci` і запускає Compose smoke. |

## Тести

```bash
(cd apps/matching-engine-service && npm ci && npm run lint:check && npx tsc --noEmit && npm test)
(cd apps/settlement-service && npm ci && npm run lint:check && npx tsc --noEmit)
(cd apps/frontend && npm ci && npm run lint && npm run build)
docker compose up -d --build --wait --wait-timeout 240
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3002/health
curl -fsS http://localhost:3000/orderbook > /dev/null
```

Jest у matching engine запускає файли `*.spec.ts` поза `test/e2e/` і `test/integration/`.
Обидва наявні тестові файли потрапляють до unit-набору. Обмеження starter-тестів описано в ТЗ.

## Аудит залежностей

CI запускає `npm audit --omit=dev --audit-level=high` у кожному пакеті. Для локальної
перевірки за тими самими правилами запустіть `node ../../scripts/audit-production.cjs`
з каталогу пакета. Нові high або critical advisory зупиняють CI. Винятки обмежено
ідентифікаторами advisory та назвами залежностей у [списку винятків](scripts/audit-allowlist.json).
Конфігурація Dependabot дозволяє patch і minor оновлення версій. GitHub читає її з
гілки за замовчуванням. [Документація GitHub](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file).

- `tar` 6 встановлюється через `bcrypt` 5 та `@mapbox/node-pre-gyp` і використовується
  для розпакування нативного модуля під час встановлення. Для зняття винятків потрібен
  перехід на `bcrypt` 6 з перевіркою збірки та автентифікації.
- Для `next` 14 залишаються advisory, зокрема про відмову в обслуговуванні. Окремі
  критичні advisory стосуються Windows-хостів або оптимізації зображень. Compose
  запускає Next.js у Linux Alpine. Для зняття винятків потрібні оновлення до виправленого
  Next.js 15 або новішого та повторна перевірка збірки, маршрутів і WebSocket. [Windows](https://github.com/advisories/GHSA-p293-qw3h-jr36), [AVIF](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4), [SVG](https://github.com/advisories/GHSA-2464-fhr4-w9xw).
- Для NestJS 10 наступний мажорний перехід — NestJS 11. Поточні lockfiles фіксують
  сумісні виправлення `body-parser`, `multer`, `lodash` і `postcss`.
