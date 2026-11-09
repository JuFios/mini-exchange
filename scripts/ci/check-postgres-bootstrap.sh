#!/usr/bin/env bash
set -eu

cd "$(dirname "$0")/../.."
project="exchange-bootstrap-$(openssl rand -hex 6)"
compose() {
  docker compose -p "$project" -f docker-compose.yml -f docker-compose.e2e.yml "$@"
}
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    compose ps -a || true
    compose logs --no-color --tail=120 || true
  fi
  compose down -v --remove-orphans
  exit "$result"
}
trap cleanup EXIT
printf 'Compose project: %s\n' "$project"
compose up -d --wait --wait-timeout 240 exchange-db

# Стан після переривання між першим CREATE ROLE і CREATE DATABASE.
test "$(compose exec -T exchange-db psql -X -U postgres -At -c \
  "SELECT count(*) FROM pg_database WHERE datname IN ('exchange','ledger')")" = 0
compose exec -T exchange-db psql -X -U postgres -v ON_ERROR_STOP=1 -c 'CREATE ROLE engine'
compose run --rm --no-deps postgres-bootstrap &
first=$!
compose run --rm --no-deps postgres-bootstrap &
second=$!
status=0
wait "$first" || status=$?
wait "$second" || status=$?
test "$status" -eq 0

compose exec -T exchange-db sh -eu <<'SH'
expect_access() {
  PGPASSWORD="$1" psql -X -w -h 127.0.0.1 -U "$2" -d "$3" -v ON_ERROR_STOP=1 -At -c 'SELECT current_user'
}
test "$(expect_access "$ENGINE_DB_PASSWORD" engine exchange)" = engine
test "$(expect_access "$LEDGER_DB_PASSWORD" ledger ledger)" = ledger
for pair in 'engine ledger' 'ledger exchange'; do
  set -- $pair
  if [ "$1" = engine ]; then password=$ENGINE_DB_PASSWORD; else password=$LEDGER_DB_PASSWORD; fi
  if result=$(expect_access "$password" "$1" "$2" 2>&1); then
    echo "Unexpected database access: $1 -> $2" >&2
    exit 1
  fi
  printf '%s\n' "$result" | grep -Fq 'permission denied for database'
done
test "$(psql -X -U postgres -At -c "
  SELECT string_agg(datname || ':' || pg_get_userbyid(datdba), ',' ORDER BY datname)
  FROM pg_database WHERE datname IN ('exchange','ledger')
")" = 'exchange:engine,ledger:ledger'
printf '%s\n' 'Bootstrap recovered; role access and database ownership verified.'
SH
