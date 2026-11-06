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

Потрібні Docker Engine **28.0.0 або новіший** та Docker Compose **2.40 або новіший**.
На старіших Docker Engine хости того самого сегмента мережі можуть дістатися до портів,
опублікованих на `127.0.0.1`. Перевірте версію сервера командою
`docker version --format '{{.Server.Version}}'`. [Документація Docker](https://docs.docker.com/engine/network/port-publishing/#publishing-ports)

Якщо оновлюєте стек зі збереженими даними Redis, спочатку виконайте перенесення нижче.

```bash
docker compose up --build
```

Якщо встановлено alias `docker-compose`, можна запустити `docker-compose up --build`.
Для запуску у фоні з очікуванням усіх healthcheck використовуйте `docker compose up -d --build --wait`.

- matching-engine-service: http://localhost:3001
- settlement-service: http://localhost:3002
- frontend: http://localhost:3000
- PostgreSQL: `127.0.0.1:5433`
- Redis у мережі Compose: `redis:6379`. Для перевірки з хоста виконайте
  `docker compose exec -T redis redis-cli PING`.

Обидва backend-сервіси повертають HTTP 200 та `{"status":"ok"}` на `GET /health`.
Це перевірка доступності HTTP-процесу. PostgreSQL і Redis мають власні healthcheck.
Redis пише AOF у том `redis-data` і працює з політикою `noeviction`. Поки Redis відтворює
AOF, невдалі healthcheck не враховуються протягом `REDIS_HEALTH_START_PERIOD` (типово `120s`).
Для більшого набору даних збільште значення, наприклад `REDIS_HEALTH_START_PERIOD=10m`, і
відповідно `--wait-timeout`.

### Віддалене розгортання

Порти `3000` і `3001` опубліковані на всіх інтерфейсах хоста. `.env.example` містить
публічні демо-секрети JWT: з ними будь-хто з доступом до порту `3001` може підписати власний
токен і діяти від імені довільного користувача. Тому стек, доступний з інших хостів,
запускайте лише з `docker-compose.remote.yml`. Цей файл вимагає власні `JWT_ACCESS_SECRET`
і `JWT_REFRESH_SECRET`, а також адресу WebSocket, доступну браузеру. Без цих значень
Compose не запуститься.

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.remote.yml
export JWT_ACCESS_SECRET="$(openssl rand -hex 32)"
export JWT_REFRESH_SECRET="$(openssl rand -hex 32)"
export NEXT_PUBLIC_WS_URL=wss://exchange.example.com
docker compose up -d --build --wait --wait-timeout 240
```

Збережіть секрети: після їх зміни раніше видані токени стають недійсними.

Для локального запуску frontend використовує `ws://localhost:3001`.
Compose також читає значення з `.env` поруч із `docker-compose.yml`. Якщо адреса вже є
в `apps/frontend/.env.production` або `apps/frontend/.env.local`, передайте відповідний файл явно,
наприклад `docker compose --env-file apps/frontend/.env.production up -d --build frontend`.
Docker передає в збірку лише публічну адресу. Для зміни адреси перебудуйте frontend.

### Перенесення даних Redis зі старого тому

Перед першим запуском оновленого стеку призупиніть записи в Redis і збережіть RDB зі
старого контейнера. Використовуйте ту саму назву проєкту Compose під час усієї процедури.

```bash
backup_dir=$(mktemp -d "${HOME}/redis-upgrade.XXXXXX")
(
  set -eu
  redis_container=$(docker compose ps -q redis)
  test -n "$redis_container"
  test "$(docker compose exec -T redis redis-cli --raw SAVE)" = OK
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
    "$redis_container" > "$backup_dir/source-volume"
  docker cp "$redis_container:/data/dump.rdb" "$backup_dir/dump.rdb"
  docker compose stop redis
  printf 'Redis backup: %s\n' "$backup_dir/dump.rdb"
)
```

З оновленою конфігурацією імпортуйте копію в порожній том `redis-data`. Процедура
завантажує RDB в ізольований Redis, створює AOF і переносить його в робочий каталог тому
після успішного завершення запису. [Перехід Redis із RDB на AOF](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/#how-i-can-switch-to-aof-if-im-currently-using-dumprdb-snapshots)

```bash
sh scripts/migrate-redis-volume.sh "$backup_dir/dump.rdb" &&
  docker compose up -d --wait redis
```

Порівняйте кількість ключів за базами командою `docker compose exec -T redis redis-cli INFO keyspace`
і перевірте значення та TTL відомих ключів. Збережіть резервну копію і старий том до завершення перевірки.
`docker compose down -v` видаляє томи і підходить лише для одноразових тестових даних.

Якщо оновлення вже запустило Redis, використайте збережений `dump.rdb` або скопіюйте
його з точно ідентифікованого старого тому, змонтованого лише для читання. Для зайнятого
`redis-data` виберіть новий том через окремий файл Compose з таким вмістом.

```yaml
volumes:
  redis-data:
    name: exchange-redis-recovered
```

Після зупинки поточного Redis задайте `COMPOSE_FILE=docker-compose.yml:redis-recovery.yml`
для імпорту та подальших запусків, якщо додатковий файл має назву `redis-recovery.yml`.
Для віддаленого розгортання додайте його після `docker-compose.remote.yml`.

Скрипт імпорту блокує том на час роботи, тому другий паралельний запуск для того самого тому
завершується помилкою. Якщо попередній імпорт перервався до публікації AOF, наприклад через
`SIGKILL` або аварійну зупинку Docker, у томі лишається лише `.redis-import`. Повторний запуск
видаляє цей каталог і виконує імпорт заново.

## Знайдені проблеми

| Симптом | Відтворення на `starter-baseline` | Виправлення |
|---|---|---|
| Збірка або запуск Docker падають, а CI не знаходить lockfiles для npm-кешу | `docker compose up -d --build --wait`, `docker compose up -d --build --wait matching-engine-service`, `npm ci` у будь-якому з трьох пакетів, `npm install && npm run build` у `apps/frontend` | Lockfiles, окремі налаштування збірки Nest, явний `varchar` для `User.refreshTokenHash`, екранування апострофа в JSX і `.dockerignore` для залежностей та артефактів хоста. CI встановлює залежності через `npm ci` і запускає Compose smoke. |
| Тест self-trade проходить, навіть коли перевірка не запобігає власній угоді | У `test/self-trade.spec.ts` початкова перевірка лише підтверджує наявність результату | Тест перевіряє угоди, статус incoming і обидві сторони книги. Підміна політики на no-op має порушити ці твердження. |
| Після часткового виконання bid і ask одного власника залишаються на однаковій ціні | X ставить sell 1 @ 100, Y ставить sell 1 @ 99, X подає buy 2 @ 100 | Угода з Y виконується за 99, залишок buy скасовується, власний ask X лишається в книзі. |

## Зіставлення заявок

Заявки виконуються за найкращою сумісною ціною заявки, що вже в книзі.
За рівної ціни першість визначає номер надходження, а в поточному HTTP-адаптері без
номерів — час створення зі збереженням початкового порядку при однаковому часі.
Коли наступною сумісною є заявка того самого власника, залишок нової заявки
отримує статус `cancelled`. Уже виконані угоди зберігаються у відповіді на
`POST /orders`, а `GET /orders` показує скасований статус. У `remainingQuantity`
такої заявки лишається скасований залишок, тож виконаний обсяг — це
`quantity - remainingQuantity` (заявка на 2, що виконала 1 і скасувала решту, має
`remainingQuantity` 1; якщо угод не було, то 2). Скасування через `DELETE /orders/:id`
поки що, як у starter, записує `remainingQuantity` 0.

Знімок книги для зіставлення або повністю з номерами надходження, або повністю без
них. Змішаний знімок відхиляється помилкою: порядок за номером і за часом створення
не узгоджується.

`POST /orders` приймає `price` (0.01–1 000 000, до 2 знаків після крапки) і `quantity`
(0.00000001–1 000 000, до 8 знаків) як JSON-числа або як десяткові рядки (`"100.25"`).
Значення за межами діапазону або з надлишковою точністю повертають HTTP 400. Для
JSON-чисел перевіряється запис із тіла запиту, а не округлене `number`: наприклад,
`1000000.00000000001` відхиляється, хоча JavaScript перетворив би його на `1000000`.
Експоненційний запис (`1e-8`) розгортається без округлення. Зіставлення оперує
цілими тиками та лотами, а ціни й кількості угод повертаються як десяткові рядки.

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
Тести зіставлення перевіряють сценарії виконання, скасування та звіряють книгу й угоди з незалежним еталоном.
