#!/bin/sh
# Перевірені origin не дозволяють Host підмінити довірене ім’я через DNS rebinding.
set -eu
set -f
if ! printf '%s' "${INGRESS_TOKEN:?INGRESS_TOKEN is required}" | grep -Eq '^[A-Za-z0-9_-]{32,128}$'; then
  echo 'INGRESS_TOKEN must contain 32 to 128 base64url characters' >&2
  exit 1
fi
if ! printf '%s' "${FRONTEND_PROXY_TOKEN:?FRONTEND_PROXY_TOKEN is required}" | grep -Eq '^[A-Za-z0-9_-]{32,128}$'; then
  echo 'FRONTEND_PROXY_TOKEN must contain 32 to 128 base64url characters' >&2
  exit 1
fi
if [ "${DEPLOYMENT_MODE:-local}" = remote ]; then
  case "$INGRESS_TOKEN $FRONTEND_PROXY_TOKEN" in *local-only*) echo 'Remote ingress credentials must not use local-only values' >&2; exit 1;; esac
fi
origins=${PUBLIC_ORIGIN:-${PUBLIC_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001}}
ws=${ENGINE_PUBLIC_WS_URL:-ws://localhost:3001}
case "$ws" in
  ws://*|wss://*|http://*|https://*) ;;
  *) echo 'Invalid public WebSocket URL' >&2; exit 1 ;;
esac
authority=${ws#*://}
authority=${authority%%[/?#]*}
if ! printf '%s' "$authority" | grep -Eq '^([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'; then
  echo 'Invalid public WebSocket host' >&2
  exit 1
fi
# URL браузера не надсилає порт за замовчуванням у Host.
case "$ws" in
  ws://*|http://*) authority=${authority%:80} ;;
  wss://*|https://*) authority=${authority%:443} ;;
esac
temporary=$(mktemp /etc/nginx/conf.d/.public-hosts.XXXXXX)
trap 'rm -f "$temporary"' EXIT
# Цей файл читається до інших map; збільшуємо bucket для довгих коректних DNS-імен.
printf 'map_hash_bucket_size 512;\nmap $http_host $exchange_public_host {\n  default 0;\n' > "$temporary"
old_ifs=$IFS
IFS=,
for origin in $origins; do
  if ! printf '%s' "$origin" | grep -Eq '^https?://(localhost|[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'; then
    echo 'PUBLIC_ORIGIN(S) must contain HTTP origins without paths or credentials' >&2
    exit 1
  fi
  if [ "${DEPLOYMENT_MODE:-local}" = remote ] && [ "${origin#https://}" = "$origin" ]; then
    echo 'Remote PUBLIC_ORIGIN must use HTTPS' >&2
    exit 1
  fi
  host=${origin#*://}
  printf '  "%s" 1;\n' "$host" >> "$temporary"
done
IFS=$old_ifs
printf '}\n' >> "$temporary"
printf 'map $http_host $exchange_ws_host {\n  default 0;\n  "127.0.0.1:3001" 1;\n' >> "$temporary"
[ "$authority" = 127.0.0.1:3001 ] || printf '  "%s" 1;\n' "$authority" >> "$temporary"
printf '}\nmap "$exchange_public_host:$exchange_ws_host" $exchange_engine_host {\n  default 1;\n  "0:0" 0;\n}\n' >> "$temporary"
mv "$temporary" /etc/nginx/conf.d/10-public-hosts.conf
