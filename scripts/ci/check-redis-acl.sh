#!/usr/bin/env bash
# Лише читання конфігурації й ACL DRYRUN: повтори, паралельні запуски й обрив не змінюють даних.
set -euo pipefail
cd "$(dirname "$0")/../.."
cli() { docker compose exec -T redis redis-cli --no-auth-warning "$@"; }
allow() {
  local user=$1; shift
  test "$(cli ACL DRYRUN "$user" "$@")" = OK
}
deny() {
  local user=$1; shift
  local result
  result=$(cli ACL DRYRUN "$user" "$@")
  if ! printf '%s' "$result" | grep -q 'has no permissions'; then
    printf 'Unexpected ACL result for %s %s: %s\n' "$user" "$1" "$result" >&2
    exit 1
  fi
}
docker compose exec -T redis sh -ec 'REDISCLI_AUTH="$REDIS_ENGINE_PASSWORD" redis-cli --user engine --no-auth-warning ping' | grep -qx PONG
docker compose exec -T redis sh -ec 'REDISCLI_AUTH="$REDIS_SETTLEMENT_PASSWORD" redis-cli --user settlement --no-auth-warning ping' | grep -qx PONG
# Повна відповідь: порожній вивід збою `docker compose exec` не має пройти як порожній пароль.
test "$(cli CONFIG GET requirepass)" = requirepass
for user in engine settlement; do
  deny "$user" FLUSHALL
  deny "$user" CONFIG SET maxmemory-policy allkeys-lru
  deny "$user" ACL LIST
done
allow engine SET 'exchange:limit:acl-probe' value PX 1000
allow engine SET 'lease:instrument:{ABC}' value PX 1000
allow engine INCR '{exchange:limit:acl-probe:auth}:hits'
allow engine XADD 'exchange:settlement:{ABC}' '*' envelope test
allow settlement XREADGROUP GROUP settlement probe STREAMS 'exchange:settlement:{ABC}' '>'
allow settlement XACK 'exchange:settlement:{ABC}' settlement 1-0
allow settlement XADD exchange:dlq '*' envelope test
allow settlement XADD exchange:user-events '*' envelope test
deny settlement XADD 'exchange:settlement:{ABC}' '*' envelope test
deny settlement SET 'lease:instrument:{ABC}' value
deny settlement DEL 'exchange:limit:acl-probe'
deny engine DEL 'exchange:settlement:{ABC}'
printf 'Redis ACL: 2 role logins, 8 allowed operations, 10 denied operations, no plaintext admin password\n'
