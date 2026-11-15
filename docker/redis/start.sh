#!/bin/sh
# ACL перезаписується атомарно: падіння до rename лишає попередні права до наступного старту.
set -eu
# Службові команди (`docker compose run redis sh ...`, імпорт тому) ACL не потребують і не мають
# лишати файлів у /data: імпорт вимагає порожній том.
# Ті самі форми, які офіційний entrypoint перетворює на запуск сервера: прапорець або `.conf`.
# Інакше такий запуск пройшов би повз ACL і став би Redis без пароля.
case "${1:-}" in -*|*.conf) set -- redis-server "$@" ;; esac
if [ "$(basename -- "${1:-}")" != redis-server ]; then exec "$@"; fi
# Офіційний entrypoint знижує права лише для `redis-server` без шляху.
shift
set -- redis-server "$@"
umask 077
hash() { printf '%s' "$1" | sha256sum | cut -d ' ' -f 1; }
: "${REDISCLI_AUTH:?REDISCLI_AUTH is required}"
: "${REDIS_ENGINE_PASSWORD:?REDIS_ENGINE_PASSWORD is required}"
: "${REDIS_SETTLEMENT_PASSWORD:?REDIS_SETTLEMENT_PASSWORD is required}"
for secret in "$REDISCLI_AUTH" "$REDIS_ENGINE_PASSWORD" "$REDIS_SETTLEMENT_PASSWORD"; do
  if [ "${#secret}" -lt 16 ]; then echo 'Redis passwords must contain at least 16 characters' >&2; exit 1; fi
done
if [ "$REDISCLI_AUTH" = "$REDIS_ENGINE_PASSWORD" ] || [ "$REDISCLI_AUTH" = "$REDIS_SETTLEMENT_PASSWORD" ] || [ "$REDIS_ENGINE_PASSWORD" = "$REDIS_SETTLEMENT_PASSWORD" ]; then
  echo 'Redis role passwords must differ' >&2
  exit 1
fi
if [ "${DEPLOYMENT_MODE:-local}" = remote ]; then
  for secret in "$REDISCLI_AUTH" "$REDIS_ENGINE_PASSWORD" "$REDIS_SETTLEMENT_PASSWORD"; do
    case "$secret" in *local-only*) echo 'Remote Redis credentials must not use local-only values' >&2; exit 1;; esac
  done
fi
temporary=$(mktemp /data/.users-acl.XXXXXX)
trap 'rm -f "$temporary"' EXIT
printf 'user default reset on #%s ~* &* +@all\n' "$(hash "$REDISCLI_AUTH")" > "$temporary"
printf 'user engine reset on #%s -@all +ping +info +quit +config|get (~exchange:limit:* ~{exchange:limit:* ~lease:instrument:* +get +set +del +incr +decr +pexpire +pttl +pexpiretime +eval) (~exchange:market:* ~exchange:settlement:* ~exchange:user-events ~exchange:outbox:* +xread +xinfo +xlen +xadd +xrange +xrevrange +hget +hset +eval)\n' "$(hash "$REDIS_ENGINE_PASSWORD")" >> "$temporary"
# Settlement може читати й підтверджувати settlement stream, а писати — лише DLQ та сповіщення.
printf 'user settlement reset on #%s -@all +ping +info +quit +config|get (~exchange:settlement:* ~exchange:dlq +eval +xreadgroup +xgroup|create +xautoclaim +xack +xpending +xinfo +xlen) (~exchange:dlq ~exchange:user-events +xadd +xlen)\n' "$(hash "$REDIS_SETTLEMENT_PASSWORD")" >> "$temporary"
if [ "$(id -u)" -eq 0 ]; then chown redis:redis "$temporary"; fi
mv "$temporary" /data/users.acl
exec /usr/local/bin/docker-entrypoint.sh "$@" --aclfile /data/users.acl
