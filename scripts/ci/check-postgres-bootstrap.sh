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

# Старий том і частково створена роль мають пережити два одночасні bootstrap.
test "$(compose exec -T exchange-db psql -X -U exchange -d postgres -At -c \
  "SELECT count(*) FROM pg_database WHERE datname IN ('exchange','ledger')")" = 0
compose exec -T exchange-db psql -X -U exchange -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE engine;
CREATE DATABASE exchange;
\connect exchange
CREATE TABLE bootstrap_probe (id bigint GENERATED ALWAYS AS IDENTITY, value text);
INSERT INTO bootstrap_probe (value) VALUES ('preserved');
CREATE SEQUENCE bootstrap_probe_seq START WITH 17;
SQL
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
test "$(PGPASSWORD="$ENGINE_DB_PASSWORD" psql -X -w -h 127.0.0.1 -U engine -d exchange \
  -v ON_ERROR_STOP=1 -At -c "SELECT value FROM bootstrap_probe WHERE id=1")" = preserved
test "$(PGPASSWORD="$ENGINE_DB_PASSWORD" psql -X -w -h 127.0.0.1 -U engine -d exchange \
  -v ON_ERROR_STOP=1 -At -c "SELECT nextval('bootstrap_probe_seq')")" = 17
PGPASSWORD="$ENGINE_DB_PASSWORD" psql -X -w -h 127.0.0.1 -U engine -d exchange \
  -v ON_ERROR_STOP=1 -c "ALTER TABLE bootstrap_probe ADD COLUMN migrated integer"
for pair in 'engine ledger' 'ledger exchange'; do
  set -- $pair
  if [ "$1" = engine ]; then password=$ENGINE_DB_PASSWORD; else password=$LEDGER_DB_PASSWORD; fi
  if result=$(expect_access "$password" "$1" "$2" 2>&1); then
    echo "Unexpected database access: $1 -> $2" >&2
    exit 1
  fi
  printf '%s\n' "$result" | grep -Fq 'permission denied for database'
done
test "$(psql -X -U exchange -d postgres -At -c "
  SELECT string_agg(datname || ':' || pg_get_userbyid(datdba), ',' ORDER BY datname)
  FROM pg_database WHERE datname IN ('exchange','ledger')
")" = 'exchange:engine,ledger:ledger'
printf '%s\n' 'Bootstrap recovered; role access and database ownership verified.'
SH
