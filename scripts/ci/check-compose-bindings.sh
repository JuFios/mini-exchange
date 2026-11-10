#!/usr/bin/env bash
# Перевіряє прив’язку портів у локальному й віддаленому запуску Compose та відмову
# віддаленого запуску без секретів. Лише `docker compose config`: нічого не стартує
# і не змінює, тож скрипт безпечно запускати повторно й паралельно.
set -eu

cd "$(dirname "$0")/../.."

# Значення лише для цієї перевірки, не для запуску.
CI_ACCESS_SECRET=ci-only-access-secret-value-000001
CI_REFRESH_SECRET=ci-only-refresh-secret-value-00001
export INTERNAL_API_TOKEN=ci-only-internal-token-value-00001
export POSTGRES_PASSWORD=ci-only-postgres-password
export ENGINE_DB_PASSWORD=ci-only-engine-password
export LEDGER_DB_PASSWORD=ci-only-ledger-password
export ADMIN_EMAILS=ci-admin@example.test
export ADMIN_PASSWORD=ci-only-admin-password-000001
export ENGINE_PUBLIC_WS_URL=wss://exchange.example.test

docker compose config --format json | jq -e '
  .services as $s |
  (["matching-engine-1","matching-engine-2"] | all(. as $name | $s[$name].ports | length == 1 and .[0].host_ip == "127.0.0.1")) and
  (["exchange-db","settlement-service"] | all(. as $name | $s[$name].ports | length == 1 and .[0].host_ip == "127.0.0.1")) and
  ($s["engine-lb"].ports | length == 2 and all(.[]; .host_ip == "127.0.0.1") and (map(.target) | sort == [3000,3001])) and
  ($s["engine-lb"].depends_on.frontend.condition == "service_healthy") and
  (["frontend","postgres-bootstrap","engine-migrate","settlement-migrate"] | all(. as $name | ($s[$name].ports // []) | length == 0)) and
  (["exchange-db","redis","matching-engine-1","matching-engine-2","engine-lb","settlement-service","frontend"] | all(. as $name | $s[$name].restart == "unless-stopped"))'
remote() {
  docker compose -f docker-compose.yml -f docker-compose.remote.yml "$@"
}
# Відмова має бути саме через відсутній секрет, а не через іншу помилку конфігурації.
expect_rejection() {
  variable=$1
  shift
  if output=$("$@" 2>&1); then
    echo "The remote settings accepted an empty $variable." >&2
    exit 1
  fi
  if ! printf '%s' "$output" | grep -qF "$variable"; then
    echo "The remote settings failed for a reason other than $variable:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}
expect_rejection JWT_ACCESS_SECRET \
  env JWT_ACCESS_SECRET= JWT_REFRESH_SECRET=refresh docker compose \
  -f docker-compose.yml -f docker-compose.remote.yml config -q
expect_rejection ADMIN_PASSWORD \
  env JWT_ACCESS_SECRET="$CI_ACCESS_SECRET" JWT_REFRESH_SECRET="$CI_REFRESH_SECRET" \
  ADMIN_PASSWORD= docker compose -f docker-compose.yml -f docker-compose.remote.yml config -q
for variable in INTERNAL_API_TOKEN POSTGRES_PASSWORD ENGINE_DB_PASSWORD LEDGER_DB_PASSWORD; do
  expect_rejection "$variable" env JWT_ACCESS_SECRET="$CI_ACCESS_SECRET" JWT_REFRESH_SECRET="$CI_REFRESH_SECRET" \
    "$variable=" docker compose -f docker-compose.yml -f docker-compose.remote.yml config -q
done
JWT_ACCESS_SECRET="$CI_ACCESS_SECRET" JWT_REFRESH_SECRET="$CI_REFRESH_SECRET" remote config --format json |
  jq -e --arg access "$CI_ACCESS_SECRET" --arg refresh "$CI_REFRESH_SECRET" \
    --arg admin "$ADMIN_EMAILS" --arg password "$ADMIN_PASSWORD" \
    --arg token "$INTERNAL_API_TOKEN" --arg postgres "$POSTGRES_PASSWORD" \
    --arg engine "$ENGINE_DB_PASSWORD" --arg ledger "$LEDGER_DB_PASSWORD" '
    .services as $s |
    (["matching-engine-1","matching-engine-2"] | all(. as $name | $s[$name].environment |
      .JWT_ACCESS_SECRET == $access and .JWT_REFRESH_SECRET == $refresh and
      .ADMIN_EMAILS == $admin and .ADMIN_PASSWORD == $password and
      .INTERNAL_API_TOKEN == $token and .DATABASE_PASSWORD == $engine)) and
    ($s["settlement-service"].environment |
      .JWT_ACCESS_SECRET == $access and .INTERNAL_API_TOKEN == $token and .LEDGER_DATABASE_PASSWORD == $ledger) and
    ($s["exchange-db"].environment.POSTGRES_PASSWORD == $postgres) and
    ($s["postgres-bootstrap"].environment |
      .POSTGRES_PASSWORD == $postgres and .ENGINE_DB_PASSWORD == $engine and .LEDGER_DB_PASSWORD == $ledger) and
    ($s["engine-migrate"].environment.DATABASE_PASSWORD == $engine) and
    ($s["settlement-migrate"].environment | .LEDGER_DATABASE_PASSWORD == $ledger and .DATABASE_PASSWORD == null) and
    ($s["settlement-service"].environment.DATABASE_PASSWORD == null) and
    (["postgres-bootstrap","engine-migrate","settlement-migrate"] | all(. as $name | ($s[$name].ports // []) | length == 0)) and
    ($s["settlement-service"].ports | length == 1 and .[0].host_ip == "127.0.0.1") and
    ($s["engine-lb"].ports | length == 2 and all(.[]; .host_ip == null) and (map(.target) | sort == [3000,3001])) and
    (["matching-engine-1","matching-engine-2"] | all(. as $name | $s[$name].ports | length == 1 and .[0].host_ip == "127.0.0.1")) and
    (($s.frontend.ports // []) | length == 0) and
    ($s.frontend.environment.COOKIE_SECURE == "true") and
    ($s.frontend.environment.ENGINE_PUBLIC_WS_URL == "wss://exchange.example.test")'

# Test-overlay не публікує портів і не використовує локальні томи.
docker compose -f docker-compose.yml -f docker-compose.test.yml config --format json | jq -e '
  .services as $s |
  (["exchange-db","redis","matching-engine-1","matching-engine-2","engine-lb","settlement-service","frontend"] |
    all(. as $name | ($s[$name].ports // []) | length == 0)) and
  (["exchange-db","redis","matching-engine-1","matching-engine-2","engine-lb","settlement-service","frontend"] |
    all(. as $name | $s[$name].restart == "no")) and
  (["matching-engine-1","matching-engine-2"] | all(. as $name | $s[$name].init == true)) and
  ($s.frontend.environment.MATCHING_ENGINE_URL == "http://engine-lb:8080") and
  (["matching-engine-1","matching-engine-2"] |
    all(. as $name | $s[$name].environment.RESERVATIONS_ENABLED == "true")) and
  ($s["matching-engine-1"].environment.LEASE_TTL_MS == "5000") and
  (.volumes | keys == ["system-db-data","system-redis-data"])'
