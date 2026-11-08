# Mini Exchange

Навчальна біржа: matching engine (NestJS, PostgreSQL, Redis), сервіс розрахунків і
веб-клієнт (Next.js). Репозиторій розвивається поетапно: нижче сказано, що працює зараз
і що ще попереду. Вимоги — у [ЗАВДАННЯ.md](ЗАВДАННЯ.md).

## Що вже працює

- `apps/matching-engine-service` — автентифікація, подача/скасування заявок,
  зіставлення за price-time priority, self-trade prevention, трансляція
  committed знімка order book через WebSocket.
- Дві репліки engine: Redis lease з TTL і renewal, PG fencing, recovery та admin resume.
- `apps/frontend` — форма подачі заявки і сторінка order book з live-оновленням.

## Що ще НЕ реалізовано / потребує уваги

- `apps/settlement-service` — лише каркас, розрахунок угод не реалізовано
  (`NotImplementedException`).
- Публікація угод у чергу подій: угоди вже зберігаються в PostgreSQL, але relay
  штатних подій ще не підключений.
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

### Схема engine

Compose запускає `engine-migrate` після готовності PostgreSQL. Engine стартує після
успішних міграцій. При збої перегляньте `docker compose logs engine-migrate`.
Повторний запуск застосує лише відсутні міграції. Паралельні запуски на одній БД
виконують міграції по черзі під блокуванням PostgreSQL. Очікування блокування обмежено
60 с, а один SQL-оператор міграції — 300 с. Якщо інша міграція тримає блокування довше,
`engine-migrate` завершується з помилкою `Timed out … migrations lock`, а engine не
стартує. Тоді перевірте активні сесії в `pg_stat_activity` і запустіть міграції знову.

Для запуску engine поза Compose задайте реквізити чистої PostgreSQL 16 через
`DATABASE_*` або `apps/matching-engine-service/.env`. У каталозі пакета після
`npm ci` виконайте `npm run migration:run` перед `npm run start:dev`.
`npm run migration:revert` відкочує одну міграцію. Перевіряйте відкат на окремій
тестовій БД, бо відкат початкової міграції видаляє таблиці та їхні дані.

Том PostgreSQL із таблицями, створеними автоматично в starter, потребує окремого
перенесення даних. Для одноразового локального стеку зі збереженою резервною копією
можна скинути томи через `docker compose down -v` і запустити стек знову.
Ця команда видалить також локальний том Redis.

- engine-lb: http://localhost:3001; репліки для діагностики: `127.0.0.1:3101` і `127.0.0.1:3102`
- settlement-service: http://localhost:3002
- frontend: http://localhost:3000
- PostgreSQL: `127.0.0.1:5433`
- Redis у мережі Compose: `redis:6379`. Для перевірки з хоста виконайте
  `docker compose exec -T redis redis-cli PING`.

Обидва backend-сервіси повертають HTTP 200 та `{"status":"ok"}` на `GET /health`.
Це перевірка доступності HTTP-процесу. PostgreSQL і Redis мають власні healthcheck. Engine також має `/ready`: PG, застосовані
міграції, Redis і `maxmemory-policy=noeviction`. Standby може бути ready без власного lease.
Перевірка міграцій читає лише таблицю `migrations` і нічого не створює.
Redis пише AOF у том `redis-data` і працює з політикою `noeviction`. Поки Redis відтворює
AOF, невдалі healthcheck не враховуються протягом `REDIS_HEALTH_START_PERIOD` (типово `120s`).
Для більшого набору даних збільште значення, наприклад `REDIS_HEALTH_START_PERIOD=10m`, і
відповідно `--wait-timeout`.

### Віддалене розгортання

Локальний Compose публікує порти `3000` і `3001` лише на `127.0.0.1`.
`.env.example` містить публічні демо-секрети JWT для цього режиму. Для доступу з інших
хостів використовуйте `docker-compose.remote.yml`. Він публікує ці порти на всіх
інтерфейсах і вимагає власні `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_EMAILS`,
`ADMIN_PASSWORD` та адресу WebSocket, доступну браузеру. Використовуйте окремий
Compose-проєкт із власними томами й адресою адміністратора. Так віддалений стек
отримає окрему БД та власні облікові дані. Override передає секрети **обом** реплікам;
прямі порти реплік лишаються на loopback. Публічний nginx listener `:3001` блокує
`/internal/` і `/metrics` (також `/Metrics` і `/metrics/`) та перезаписує `X-Forwarded-For`. Внутрішній `:8080` не публікується;
frontend звертається до нього через `MATCHING_ENGINE_URL=http://engine-lb:8080`.

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.remote.yml
export JWT_ACCESS_SECRET="$(openssl rand -hex 32)"
export JWT_REFRESH_SECRET="$(openssl rand -hex 32)"
export ADMIN_EMAILS=admin@exchange.example.com
export ADMIN_PASSWORD="$(openssl rand -hex 24)"
export NEXT_PUBLIC_WS_URL=wss://exchange.example.com
docker compose -p mini-exchange-remote up -d --build --wait --wait-timeout 240
```

Збережіть секрети в захищеному сховищі. Зміна JWT-секретів робить видані токени
недійсними. `ADMIN_PASSWORD` задає початковий пароль нових admin-акаунтів.

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
| Можна скасувати чужу або виконану заявку | `test/e2e/regression/cancel-access.e2e-spec.ts` | Пошук за ID і власником, cancel-команда в порядку `seq`, перевірка фінального результату та збереження залишку. |
| Глибина розкриває ID і власників, показує початковий обсяг | `test/e2e/regression/depth-leak.e2e-spec.ts` | HTTP і WebSocket повертають агреговані залишки за ціною. |
| Некоректні параметри заявок приймаються або дають HTTP 500 | `test/e2e/regression/order-validation.e2e-spec.ts` | Межі й точність сум, перелік інструментів, перевірка UUID і відхилення зайвих полів. |
| Паралельні заявки гублять рівні книги, повторно виконують lot або конфліктують із cancel | `test/e2e/regression/concurrent-orders.e2e-spec.ts` | Один worker на інструмент, спільний порядок submit/cancel. |
| Зачеплена resting-заявка лишається в старому стані в БД | `test/e2e/regression/resting-persistence.e2e-spec.ts` | Одна транзакція записує всі зміни заявок і trades. |
| Після рестарту книга порожня | `test/e2e/regression/book-restore.e2e-spec.ts` | Recovery читає committed resting-заявки й звіряє лічильники. |
| Після падіння власника Redis lock лишається назавжди | `test/integration/redis-lock.spec.ts`: acquire без release; на початковому коді `PTTL=-1`. Червоний коміт `88e28a3`, виправлення `5b5cc7c` | `SET NX PX`, атомарні Lua renew/release; інтеграційні тести перевіряють SIGKILL дочірнього процесу й захист replacement lease. |
| Cancel обнуляє невиконаний залишок | `test/e2e/regression/cancel-remainder.e2e-spec.ts` | Залишок і виконаний обсяг зберігаються. |

## Зіставлення заявок

Заявки виконуються за найкращою сумісною ціною заявки, що вже в книзі.
За рівної ціни першість визначає `prioritySeq`: номер submit-команди. Часткове
виконання не змінює пріоритет. Адаптер `matchOrder` зберігає підтримку старих фікстур без номерів.
Коли наступною сумісною є заявка того самого власника, залишок нової заявки
отримує статус `cancelled`. Уже виконані угоди зберігаються у відповіді на
`POST /orders`, а `GET /orders` показує скасований статус. У `remainingQuantity`
такої заявки лишається скасований залишок, тож виконаний обсяг — це
`quantity - remainingQuantity` (заявка на 2, що виконала 1 і скасувала решту, має
`remainingQuantity` 1; якщо угод не було, то 2). Скасування через `DELETE /orders/:id`
також зберігає скасований залишок і вже виконаний обсяг.

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

## Зміни контрактів і поведінки

- `POST /auth/register` і `POST /auth/login` повертають `{accessToken, refreshToken}`.
  `POST /auth/refresh` з тілом `{"refreshToken":"..."}` повертає HTTP 200 і нову пару.
  Повтор попереднього refresh у межах `REFRESH_REUSE_GRACE_MS` (типово 10 с) повертає
  лише `{accessToken}`. Клієнт у цьому випадку зберігає поточний refresh. Повтор після
  цього вікна або використання старішого refresh відкликає сесію і повертає 401.
  Відповіді з токенами мають `Cache-Control: no-store`. `POST /auth/logout` з тим самим
  форматом тіла відкликає сесію й повертає 204.
- Engine перевіряє тип токена і підпис окремим секретом для кожного типу. Токени,
  видані до оновлення, потребують повторного входу. Акаунт має одну refresh-сесію:
  новий вхід замінює попередню, і refresh старого клієнта повертає 401, не зачіпаючи
  нову сесію. Вихід і відкликання завершують refresh-сесію, а виданий access діє
  до `exp`, щонайбільше 15 хв.
- Після міграцій engine створює admin-акаунти з `ADMIN_EMAILS`. Для локального
  запуску увійдіть на `POST /auth/login` як `admin@demo.local` з `ADMIN_PASSWORD`
  з `apps/matching-engine-service/.env.example`. Реєстрація налаштованих адрес дає
  409. Якщо адреса вже належить звичайному користувачу, engine відхиляє старт.
  Адреси в `ADMIN_EMAILS` мають бути ASCII (IDN-домен записують у punycode), бо регістр
  порівнюють JavaScript і PostgreSQL. Повторний старт зберігає пароль seed-акаунта. Після вилучення адреси з
  `ADMIN_EMAILS` раніше видана роль зберігається до закінчення access JWT.
- `GET /instruments` публічно повертає символи, активи, тики, лоти й межі заявок. Перелік
  читається з таблиці `instruments`. Міграція додає `ABC,XYZ` з котируванням в USD.
  Тик, лот і межі кількості та ціни закріплені CHECK-обмеженнями на значення, які
  перевіряє парсер сум, тож таблиця не може оголосити інші межі.
  На старті engine звіряє весь перелік із обов’язковою змінною `INSTRUMENTS`.
  `PORT` та `INSTANCE_ID` також обов’язкові.
- `GET /instruments/ABC/book?depth=50` і сумісний `GET /orders/book?instrument=ABC` доступні
  без JWT. Відповідь містить `instrument`, десятковий рядок `seq`, `bids` і `asks`. Кожен рівень містить
  `price`, суму відкритих залишків `quantity` та кількість заявок `orders`. Ціна й
  кількість — точні десяткові рядки. `depth` задає 1–50 рівнів на сторону, типово 50.
  `seq` відповідає останній застосованій команді книги worker.
- Подія `book` на публічному WebSocket повертає ті самі агреговані `bids` і `asks`.
  Підписка `subscribe` приймає символ із переліку інструментів.
- `POST /orders` повертає 400 для порожнього чи невідомого інструмента або зайвих полів.
  Ціни й кількості приймаються як JSON-числа та десяткові рядки. Некоректна сума завжди
  повертає `message` з масивом українських повідомлень, незалежно від типу значення.
- Зайві поля тіла чи query відхиляються глобально: те саме 400 «Зайве поле …» діє для
  `/auth/register`, `/auth/login` і `DELETE /orders/:id`. Раніше такі поля мовчки відкидались.
- `DELETE /orders/:id` вимагає JWT. Чужа або відсутня заявка повертає 404, закрита — 409,
  некоректний UUID — 400. Необов’язковий `?instrument` лише звіряється зі збереженим
  інструментом, незбіг повертає 400. Успішне скасування повертає 200 `{order}`; до застосування — 202 `{orderId, cancelSeq}`.

Для запуску matching engine без Compose скопіюйте `apps/matching-engine-service/.env.example`
у `.env` у каталозі пакета. Задайте адреси PostgreSQL і Redis, доступні з вашого хоста,
і згенеруйте власні JWT-секрети командами з розділу віддаленого розгортання.

## Розробка

**Коміти й PR.** Формат — [Conventional Commits](https://www.conventionalcommits.org/uk/v1.0.0/):
`type(scope): description`. Тип — `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`,
`chore`, `perf`, `style` або `revert`; scope — зі списку в `commitlint.config.cjs`. Заголовок
пишеться англійською, наказовим способом, з малої літери, без крапки, до 72 символів;
несумісна зміна позначається `!` і footer-ом `BREAKING CHANGE:`. Назва PR має той самий
формат, бо стає темою merge-коміту. PR мержиться merge-комітом, щоб пара «тест відтворює
дефект» і «виправлення» лишалася в історії окремими комітами.

```bash
npx --yes -p @commitlint/cli@19.8.1 commitlint --config commitlint.config.cjs --from origin/solution
```

**Стиль.** Форматує Prettier за єдиним `.prettierrc.json`, відступи й кінці рядків
задає `.editorconfig`. У кожному пакеті: `npm run format` виправляє файли,
`npm run format:check` лише перевіряє (так само в CI). Щоб `git blame` пропускав
одноразове форматування:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

**Перед PR** виконайте команди з розділу «Тести». CI повторює їх і додатково збирає стек
у Compose. Скрипти перевірок Compose лежать у `scripts/ci/` і запускаються локально так
само, як у CI.

## Тести

```bash
(cd apps/matching-engine-service && npm ci && npm run format:check && npm run lint:check && npm run typecheck && npm test)
(cd apps/settlement-service && npm ci && npm run format:check && npm run lint:check && npm run typecheck && npm test)
(cd apps/frontend && npm ci && npm run format:check && npm run lint && npm run typecheck && npm run build)
docker compose up -d --build --wait --wait-timeout 240
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3002/health
curl -fsS http://localhost:3000/orderbook > /dev/null
```

Тести matching engine потребують Node.js 20.12 або новішого (`util.parseEnv`).
Jest у matching engine запускає файли `*.spec.ts` поза `test/e2e/` і `test/integration/`.
Тести зіставлення перевіряють сценарії виконання, скасування та звіряють книгу й угоди з незалежним еталоном.
Інтеграційний сценарій 200 HTTP-заявок тепер запускає worker на обох репліках:
lease має обрати єдиного writer. `waitFor` отримав опційний інтервал 50 мс для TTL-тесту;
дефолтні 10 мс і всі наявні assertions збережені.

У тесті сервісу заявок перевірка STP читає внутрішній знімок книги напряму, щоб
зберегти перевірку конкретної resting-заявки після зміни публічної глибини. У
HTTP-тесті точності використано дійсний символ `ABC`. Рядок і вкладене число, які
перевіряють виділення JSON-чисел верхнього рівня, лишаються в полі `note` тестової фікстури.

### Engine e2e

Запустіть з кореня репозиторію після `npm ci` у пакеті matching engine. Кожен запуск
створює окремий Compose-проєкт зі своїми томами й динамічними портами на loopback.
Тестова роль PostgreSQL створює окрему БД для кожного набору, а після тестів її видаляє.
Перед запуском застосунку тестовий хелпер виконує міграції в цій БД.
Тест JWT без ідентифікатора власника підписує токен із новим полем `typ`, щоб
перевірка й далі стосувалася відсутнього `sub`. Unit-тест обробки сум підміняє
репозиторій інструментів, бо каталог тепер читається з БД.

```bash
(
  set -eu
  project="exchange-e2e-$(openssl rand -hex 6)"
  e2e() {
    docker compose -p "$project" -f docker-compose.yml -f docker-compose.e2e.yml "$@"
  }
  cleanup() {
    result=$?
    if [ "$result" -ne 0 ]; then
      e2e ps -a || true
      e2e logs --no-color --tail=200 || true
    fi
    e2e down -v --remove-orphans || true
    exit "$result"
  }
  trap cleanup EXIT
  printf 'Compose project: %s\n' "$project"
  e2e up -d --wait --wait-timeout 240 exchange-db redis
  pg_address=$(e2e port exchange-db 5432)
  redis_address=$(e2e port redis 6379)
  export DATABASE_HOST=127.0.0.1 DATABASE_PORT=${pg_address##*:}
  export DATABASE_USER=exchange DATABASE_PASSWORD=exchange DATABASE_NAME=postgres
  export REDIS_HOST=127.0.0.1 REDIS_PORT=${redis_address##*:}
  (cd apps/matching-engine-service && npm run test:e2e)
)
```

Після `SIGKILL` повторний запуск отримає інший проєкт і порти. Прибрати ресурси
перерваного тесту можна командою `docker compose -p ІМʼЯ_ПРОЄКТУ -f docker-compose.yml -f docker-compose.e2e.yml down -v`
з кореня репозиторію, використавши надруковану назву проєкту.

Скасування частково виконаної заявки зберігає її невиконаний залишок. Виконаний обсяг
не змінюється; скасований залишок більше не бере участі в matching.

Matching зберігає incoming, усі зачеплені resting-заявки, trades і номер застосованої
команди однією транзакцією. HTTP більше не змінює книгу напряму.

Під час старту engine відновлює книгу з `open` і `partially_filled` у PostgreSQL.
Перезапуск зберігає залишки й порядок заявок.


## Прийом і застосування команд

`POST /orders` повертає `{order, trades}`. Код 201 означає застосовану команду; 202 —
заявку `pending`, якщо `ORDER_SYNC_WAIT_MS` минув раніше. Після 202 перечитайте
`GET /orders/:id` або `GET /orders?status=active`. `trades` — угоди цієї заявки.
Повтор із тим самим `Idempotency-Key` повертає 200 і поточний стан тієї самої заявки.
Заявка та її trades читаються в одному snapshot `REPEATABLE READ READ ONLY`, щоб
одночасний fill не змішав два стани в одній відповіді.
Формат ключа — 1–64 латинські літери, цифри, `_` або `-`. Ключ належить користувачу;
інше нормалізоване тіло з цим ключем дає 409 `IDEMPOTENCY_KEY_REUSED`.
Без ключа кожен запит створює нову заявку. Ключі й журнал команд поки не видаляються.

Прийом створює `order_requests`, а потім однією транзакцією збільшує `instruments.next_seq`,
вставляє команду та заявку `pending`. Row lock серіалізує прийом із різних процесів.
Помилка або дубль відкочує інкремент разом із командою, тому номерів без команд немає.
«Надходження» означає COMMIT видачі `seq`, після резервування: повільніший reserve може
отримати пізніший номер. Наразі `RESERVATIONS_ENABLED=false`: Noop-клієнт дозволяє
прийом без перевірки балансу. Увімкнення резервів без HTTP-клієнта відхиляє старт.

Worker бере строго наступний `seq`. Книга живе в пам’яті; кожна команда синхронно
комітиться до підтвердження й зміни книги. Це посилює періодичну персистенцію:
після kill прийняте лишається в PostgreSQL, а після невдалого COMMIT пам’ять
відновлюється з БД. Невідома відповідь COMMIT також потребує recovery.
Перевірка `version` не дає перезаписати неочікувано змінену заявку.
Для poison-команди зберігаються `rejected_internal`, скасована заявка з причиною
`rejected`, `book.delta` фактично змінених рівнів (порожня для відхиленого submit) й `order.closed` із сумою release в outbox; черга продовжується.
Публікація штатних подій і їхній relay ще не підключені.

LISTEN/NOTIFY лише пришвидшує роботу: polling кожні `COMMAND_POLL_INTERVAL_MS` читає PG,
а HTTP після сигналу або таймауту читає committed стан. Втрачений NOTIFY не губить команду.
Одна заявка може мати кілька waiter для різних submit/cancel `seq`. LISTEN-клієнт
перепідключається після розриву.

Обидві репліки Compose мають `ENGINE_WORKER_ENABLED=true`. Кожна може приймати
HTTP-запити, але matching виконує лише власник lease інструмента. `ENGINE_WORKER_ENABLED=false`
вимикає matching на окремому екземплярі для діагностики. REST і початковий legacy WS snapshot
читають один committed стан PostgreSQL на owner і standby. Публічні читання книги
обмежені трьома одночасними запитами на репліку (черга до 200 і не довше 2 с, далі 503 `BOOK_BUSY`), щоб не
відбирати з’єднання в worker; PostgreSQL сам сортує рівні й застосовує `depth`. Legacy namespace `/` ще не має
sequence/resync або потоку оновлень; для актуального знімка повторіть підписку.

`DELETE /orders/:id` створює не більше однієї cancel-команди. Якщо заявка вже термінальна
або попередня команда встигла її виконати, відповідь — 409 `ORDER_ALREADY_FILLED` чи
`ORDER_ALREADY_CANCELLED` з фінальним `{order}`. Cancel і submit застосовуються в одному
порядку. Cancel доступний при відмові Redis; новий submit повертає 503. Відмова PG чи
таймаут блокування також повертає 503. Ідемпотентний ключ дозволяє безпечно повторити submit.

## Читання заявок і угод

`GET /orders/:id` вимагає JWT: власна заявка — 200, чужа або відсутня — 404.
`GET /orders?status=active|filled|all&instrument=ABC&limit=50&cursor=...` повертає масив
власних заявок. Типово `all`, ліміт 50; допустимі ліміти 1–100. `active` включає `pending`,
`open` і `partially_filled`. Сортування — `createdAt DESC, id DESC`.
Курсор наступної сторінки — base64url від JSON `{"createdAt":"…","id":"…"}` останньої
отриманої заявки. Порожній масив означає кінець. Однаковий `createdAt` не створює
пропусків завдяки другій частині курсора, `id`.

`GET /instruments/ABC/trades?limit=50` публічний. Ліміт 1–100. Новіші `seq` і fill йдуть
першими. Поля: `tradeId`, `seq`, `price`, `quantity`, `takerSide`, `executedAt`;
ID ордерів і користувачів у публічній стрічці відсутні.

## Recovery і зупинений інструмент

Recovery сортує заявки за ціною й `prioritySeq`, перевіряє загальні та окремі для bids/asks
кількість заявок і суму lots, а також відсутність перехрещення книги. Нова міграція
додає окремі лічильники сторін. Міграції виконуються під наявним advisory lock;
перерваний запуск відкочується й повторюється. Їхні тести тепер перевіряють п’ять міграцій
та п’ять послідовних revert замість двох, зі збереженням перевірок чистої схеми.

Розбіжність recovery або gap довше `SEQ_GAP_ALERT_MS` ставить `instrument_state.status=halted`.
Стан переживає restart. Submit і cancel повертають 503 `INSTRUMENT_HALTED`; нові команди
не приймаються й не застосовуються. Логи містять `alert=engine_recovery_mismatch` або
`alert=engine_seq_gap`. Автоматичного resume немає. Перед відновленням необхідно
порівняти журнал, лічильники й фактичні resting-заявки.
`POST /admin/instruments/ABC/resume` з access-токеном admin передає запит поточному власнику
через NOTIFY, незалежно від репліки HTTP. Власник під fenced row lock повторює recovery.
Перед активацією також перевіряється суцільний журнал від 1 до `next_seq`: застосований
префікс до `last_applied_seq`, незастосований суфікс і узгодженість обох лічильників.
Невиправлена прогалина чи хибний `applied_at` блокують resume та подальший intake.
Збіг — 200 `{status:"active"}`, розбіжність — 409 `RECOVERY_MISMATCH`.
Непідтверджений legacy стан (`legacy_verified=false`) завжди дає 409; `force` немає.
Невідомий інструмент дає 400, відсутній власник або втрачений NOTIFY — 503.
Власник підтверджує запит одразу: без підтвердження 503 приходить через 3 с, після нього
результат чекається до 12 с (lock 3 с і перевірка журналу до 10 с). Запит журналу має
власний `statement_timeout=10s`. Recovery-транзакція також має `statement_timeout=10s` і
`idle_in_transaction_session_timeout=10s`, бо читання й сортування великої книги довше за
5 с і 2 с простою; решта сесій лишається на 5 с і 2 с. Очікування вільного з’єднання пулу — до 10 с.
Публікація NOTIFY обмежена 2 с: зависле з’єднання розривається й перепідключається, тож запит
не чекає на нього довше за дедлайн підтвердження.
Повтор перевіряє дані знову. Звичайний користувач отримує 403, без токена — 401.

Діагностика з кореня локального Compose-проєкту:

```bash
docker compose logs --no-color --tail=200 matching-engine-1 matching-engine-2
docker compose exec -T exchange-db psql -U exchange -d exchange -c 'SELECT * FROM instrument_state;'
docker compose exec -T exchange-db psql -U exchange -d exchange -c 'SELECT instrument,seq,type,order_id,applied_at,result FROM order_commands ORDER BY instrument,seq;'
```

Для довгого recovery healthcheck має початкове вікно 120 с і 10 спроб через 5 с. Прогін на 10 000 resting-заявках
перевіряє, що навіть десятикратний виміряний старт вкладається в це вікно. Тестові дані
не доводять такої межі для довільного обсягу: перед збільшенням навантаження виміряйте
recovery на своїй БД. Знімки книги для прискорення старту поки не реалізовані.

Тести HTTP-лексем підміняють intake, але викликають справжню нормалізацію сум.
Перевірки STP, що раніше викликали HTTP-сервіс із фейковим репозиторієм, тепер проходять
через HTTP, worker і реальний PG у `worker-contracts.e2e-spec.ts`, з тими самими сумами
та сильнішими перевірками `filledQuantity`. Unit перевіряє нормалізацію перед прийомом.
Тест глибини перевіряє додане поле `seq`; інші assertions не послаблено.
Frontend-форма читає `{order,trades}`, окремо показує `pending` і надсилає точні рядки сум.


Оновлення БД із заявками попереднього engine виконуйте із зупиненим старим writer:

```bash
docker compose down --remove-orphans
docker compose up -d --build --wait --wait-timeout 240
```

Старі записи БД не є авторитетною книгою: попередній matcher міг виконати maker у пам’яті,
не оновивши його в БД. Тому імпортовані раніше записи `imported_snapshot` позначаються
`unverified_snapshot`, а інструмент отримує `legacy_verified=false` та `halted`.
Пріоритети, sequence й лічильники імпорту зберігаються лише як діагностичні дані.
Loader не публікує та не застосовує таку книгу, навіть якщо вручну змінити status на active.
Публічна глибина повертає 503 INSTRUMENT_HALTED замість достовірного на вигляд порожнього snapshot.
Потрібні авторитетний знімок старої книги та явна звірка; автоматичне підтвердження
legacy-даних і їхній resume не реалізовані. Зміна одного прапорця не є звіркою.
Нова чиста БД працює без цього обмеження. Down міграції не відновлює matching:
позначки unverified та halted зберігаються. Перед оновленням збережіть резервну копію БД.

Курсор передає в SQL лише `createdAt` та `id`; додаткові JSON-поля не змінюють owner чи
instrument фільтри. Запит угод заявки використовує індекси обох order ID; перевірка
EXPLAIN на 20 000 trades підтверджує використання обох індексів без Seq Scan.

Тест 200 одночасних HTTP-запитів має окремий клієнтський timeout 15 с для повільного CI.
Кількість запитів і assertions seq, унікальності, trades та replay лишаються незмінними.

Gap перевіряється також на хвості журналу: якщо `next_seq` уже видано, але очікуваного
рядка немає, після `SEQ_GAP_ALERT_MS` інструмент переходить у halted без нової заявки.
Команда й виданий лічильник читаються одним SQL snapshot, тому конкурентний COMMIT не
створює хибного gap. Повтор завершеного ідемпотентного запиту перевіряє hash і читає
збережений результат до Redis та перевірок нового прийому. Під час відмови Redis
accepted повертає 200, rejected — збережену 422, інше тіло — 409; новий прийом — 503.

Якщо запис applied-команди не оновився, вся TX matching відкочується; last_applied_seq не просувається.


## Володіння інструментом і failover

`lease:instrument:{ABC}` містить унікальний токен екземпляра. TTL — 5000 мс,
renew — 1500 мс, запас до step down — 500 мс. Власник відмовляється від lease за
монотонним дедлайном, навіть якщо запізніла відповідь renew каже «успіх». Redis-клієнт
не накопичує offline-команди; команда й початкове підключення обмежені 1000 мс.
Старий токен не може продовжити чи видалити lease нового власника.

Lease визначає кандидата. Право запису дає PostgreSQL: takeover збільшує
`owner_epoch`; кожна TX matching блокує `instrument_state`, перевіряє епоху й завершується
умовним UPDATE з тією самою епохою та попереднім `last_applied_seq`. Помилка відкочує
orders, trades і outbox разом. Пам’ять оновлюється після COMMIT. У сесіях engine:
`idle_in_transaction_session_timeout=2s`, `statement_timeout=5s`; захоплення рядка має
`lock_timeout=3s`. Призупинений усередині TX процес не блокує takeover безкінечно.

Орієнтир простою після crash — близько 7 с: TTL + acquire кожні 1000 мс з jitter
0–300 мс + recovery. Це діє за доступності Redis і PG резервній репліці, до 10 000
resting-заявок на інструмент та без стрибків годинника Redis. System-тест вимагає ≤ 10 с;
після SIGTERM — ≤ 2 с. Виміряно: **SIGTERM 537 мс, SIGKILL 4500 мс**.
`takeoverMs` — `recovered_at` нової епохи мінус останній `applied_at` старої епохи;
це верхня межа простою, обидві мітки походять з одного PG.

`GET /admin/instruments` повертає власника, епоху, TTL, `lastAppliedSeq`, `maxSeq`, backlog,
best bid/ask, кількість рівнів і resting-заявок та `outboxBacklog`. `/metrics` містить
лічильники mismatch, fenced writes, помилок renew і стан halted. Лічильники належать одній
репліці, тому `/metrics` недоступний через публічний `:3001` (404): збирайте його з
`127.0.0.1:3101` і `:3102`. Збій Redis не ховає решту полів: `leaseTtlMs` тоді `null`. Для розбору halted:

```sql
SELECT instrument,status,owner_instance,owner_epoch,last_applied_seq,
       resting_bid_count,resting_ask_count,resting_bid_lots,resting_ask_lots
FROM instrument_state;
SELECT instrument,side,count(*),sum(remaining_quantity) * 100000000 AS lots
FROM orders WHERE status IN ('open','partially_filled') GROUP BY instrument,side;
SELECT instrument,seq,type,order_id,applied_at,result FROM order_commands ORDER BY instrument,seq;
```

Виправляйте дані лише після звірки з авторитетним журналом. Після виправлення викличте
resume й перевірте, що backlog зменшується в порядку `seq`. Автоматичного підтвердження
legacy даних немає.

### System-перевірки ownership

Runner має Docker CLI і socket для керування контейнерами свого Compose-проєкту.
Контейнери вибираються за project/service labels. PostgreSQL advisory lock не дозволяє
два ownership-сценарії одночасно на одній БД. На старті runner відновлює зупинені репліки,
тож повтор після переривання між kill і restore не потребує ручного start.

```bash
(
  set -eu
  export COMPOSE_PROJECT_NAME="exchange-system-$(openssl rand -hex 6)"
  export COMPOSE_FILE=docker-compose.yml:docker-compose.test.yml
  cleanup() {
    result=$?
    if [ "$result" -ne 0 ]; then
      docker compose ps -a || true
      docker compose logs --no-color --tail=200 || true
    fi
    docker compose --profile test down -v --remove-orphans || true
    exit "$result"
  }
  trap cleanup EXIT
  printf 'Compose project: %s\n' "$COMPOSE_PROJECT_NAME"
  docker compose build system-tests
  docker compose run --rm --no-deps system-tests sh -ec 'npm run format:check && npm run typecheck'
  docker compose up -d --build --wait --wait-timeout 240
  docker compose run --rm system-tests npm run realtime:transport
  docker compose run --rm system-tests npm run chaos:sigterm
  docker compose run --rm system-tests npm run ownership:kill
  docker compose run --rm system-tests npm run ownership:hooks
)
```

Репліки engine мають `restart: unless-stopped`, щоб впала репліка поверталася як резерв.
Test-overlay не публікує host-портів, використовує окремі томи та `restart: "no"`.
TTL лишається production-значенням. Збережені команди перевіряються незалежним matcher;
будь-яка розбіжність, дубль чи перевищення takeover завершує runner кодом 1.
При обриві, 502/503/504 або таймауті запит повторюється з тим самим `Idempotency-Key`
до 30 с, з backoff 250–2000 мс. Nginx не повторює POST на іншу репліку.
При SIGKILL усього shell trap не виконається: стек і томи лишаться. Їх можна прибрати
через `docker compose -p НАДРУКОВАНИЙ_ПРОЄКТ -f docker-compose.yml -f docker-compose.test.yml --profile test down -v`.
Ця команда видаляє лише тестові томи вибраного проєкту.

`CHAOS_ENABLED` читається після завантаження конфігурації: значення з локального `.env`
діє так само, як змінна середовища процесу. `CHAOS_ENABLED=false` у звичайному стеку:
маршруту `/admin/chaos` немає.
Test-overlay вмикає його для seeded admin. Репліки мають `init: true`: Node не є
PID 1, тому self-SIGKILL hooks справді завершують процес; init також збирає дочірні процеси. Хуки `after_writes_before_commit`
і `after_commit_before_memory` завершують процес через SIGKILL; `stall_before_commit`
чекає `CHAOS_STALL_BEFORE_COMMIT_MS`. `fromSeq` та `requireTrades` обмежують спрацювання.

Settlement поки не має тестових сценаріїв. Його `npm test` явно дозволяє порожній набір
через `--passWithNoTests`; CI викликає той самий скрипт.

### Транспорт і точність публічної книги

Socket.IO працює лише через WebSocket. Клієнтам потрібно явно задати
`io(url, { transports: ['websocket'] })`; HTTP polling повертає 400 `Transport unknown`.
Це дозволяє балансувати з’єднання між репліками без sticky sessions. Після reconnect
клієнт повторює `subscribe`, щоб отримати committed snapshot. Frontend уже задає цей
транспорт. System-перевірка перевіряє підключення, повторне підключення та snapshot
через публічний і внутрішній listener nginx, а також явне відхилення polling.

Обсяг цінового рівня — точна сума залишків із 8 десятковими знаками у рядку.
Він може перевищувати максимальний обсяг однієї заявки: перевірка 10 000 заявок
по 1 000 000 і ще одного lot перевіряє REST та WebSocket без переповнення агрегату.
