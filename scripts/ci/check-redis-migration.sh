#!/usr/bin/env bash
# Перевіряє перенесення даних зі старого тому Redis: перервану спробу, зайнятий том і
# збереження ключа з TTL після перезапуску.
#
# Працює у власному Compose-проєкті й видаляє лише його контейнери та томи. Два запуски
# одночасно не підтримуються: проєкти мають фіксовані імена. Журнали контейнерів
# зберігаються у виводі до очищення, якщо перевірка впала.
set -eu

cd "$(dirname "$0")/../.."

# Ім’я не береться із зовнішнього оточення: `down -v` нижче не має зачепити чужий проєкт.
export COMPOSE_PROJECT_NAME=redis-upgrade-smoke

# SIGKILL не виконує trap, тож залишки перерваного запуску прибираємо на старті.
# Контейнер-утримувач тримає том, тож його видаляємо раніше за Compose-проєкти.
holder_label=ci.check=redis-migration-holder
leftover=$(docker ps -aq --filter "label=$holder_label")
if [ -n "$leftover" ]; then
  # shellcheck disable=SC2086
  docker rm -f $leftover >/dev/null
fi
docker compose -p redis-upgrade-source down -v --remove-orphans >/dev/null 2>&1 || true
docker compose down -v --remove-orphans >/dev/null 2>&1 || true

fixture=$(mktemp -d)
holder=
source_compose() {
  docker compose -p redis-upgrade-source -f "$fixture/compose.yml" "$@"
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for project in redis-upgrade-source redis-upgrade-smoke; do
      echo "::group::Compose project $project"
      if [ "$project" = redis-upgrade-source ]; then
        source_compose ps -a || true
        source_compose logs --no-color --tail=200 || true
      else
        docker compose ps -a || true
        docker compose logs --no-color --tail=200 || true
      fi
      echo '::endgroup::'
    done
  fi
  if [ -n "$holder" ]; then
    docker rm -f "$holder" || true
  fi
  docker compose down -v --remove-orphans || true
  source_compose down -v --remove-orphans || true
  rm -rf "$fixture"
  exit "$status"
}
trap cleanup EXIT
cat > "$fixture/compose.yml" <<'YAML'
services:
  redis:
    image: redis:7-alpine
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 1s
      timeout: 2s
      retries: 10
YAML
source_compose up -d --wait --wait-timeout 60 redis
source_compose exec -T redis redis-cli -e SET smoke:upgrade preserved EX 3600
source_compose exec -T redis redis-cli -e SAVE
source_compose cp redis:/data/dump.rdb "$fixture/dump.rdb"
# Імітуємо імпорт, убитий до публікації AOF.
docker compose run --rm --no-deps -T redis \
  sh -ec 'mkdir -p /data/.redis-import/appendonlydir && echo partial > /data/.redis-import/dump.rdb'
# Звичайний контейнер тримає блокування, тож скрипт проходить перевірку Compose.
volume=$(docker volume ls -q \
  --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --filter label=com.docker.compose.volume=redis-data)
test -n "$volume"
holder=$(docker run -d --label "$holder_label" -v "$volume:/data" redis:7-alpine sh -ec 'exec 9</data; flock 9; sleep 300')
# Чекаємо до 30 с, поки контейнер візьме блокування. Без `timeout`: його немає в macOS.
locked=
for _ in $(seq 30); do
  if docker exec "$holder" sh -c 'exec 9</data; ! flock -n 9'; then
    locked=1
    break
  fi
  sleep 1
done
if [ -z "$locked" ]; then
  echo 'The helper container did not take the volume lock in 30 seconds.' >&2
  exit 1
fi
if busy=$(sh scripts/migrate-redis-volume.sh "$fixture/dump.rdb" 2>&1); then
  echo 'The import ran while another import held the volume.' >&2
  exit 1
fi
printf '%s\n' "$busy" | grep -qxF 'Another Redis import is using the destination volume.'
docker rm -f "$holder"
holder=
sh scripts/migrate-redis-volume.sh "$fixture/dump.rdb"
docker compose up -d --wait --wait-timeout 60 redis
docker compose up -d --force-recreate --wait --wait-timeout 60 redis
test "$(docker compose exec -T redis redis-cli -e --raw GET smoke:upgrade)" = preserved
test "$(docker compose exec -T redis redis-cli -e --raw TTL smoke:upgrade)" -gt 0
