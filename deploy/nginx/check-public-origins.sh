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
# getent у образі nginx Alpine стискає IPv6 як браузер. Для IPv4-mapped адрес
# його десятковий хвіст переводимо у два шістнадцяткові блоки, як у браузерному Host.
canonical_host() {
  case "$1" in
    \[*\]*)
      literal=${1#\[}
      suffix=${literal#*\]}
      literal=${literal%%\]*}
      case "$literal" in
        *:*) ;;
        *) echo 'Invalid public IPv6 host' >&2; return 1 ;;
      esac
      if ! address=$(getent hosts "$literal" | LC_ALL=C awk '
        NR == 1 {
          host = $1
          if (host ~ /^::ffff:[0-9.]+$/) {
            tail = substr(host, 8)
            if (split(tail, octets, /[.]/) != 4) exit 1
            host = sprintf("::ffff:%x:%x", 256 * octets[1] + octets[2], 256 * octets[3] + octets[4])
          }
          if (host !~ /^[0-9a-f:]+$/) exit 1
        }
        END { if (host == "") exit 1; print host }
      '); then
        echo 'Invalid public IPv6 host' >&2
        return 1
      fi
      printf '[%s]%s\n' "$address" "$suffix"
      ;;
    *) printf '%s\n' "$1" ;;
  esac
}
origins=${PUBLIC_ORIGIN:-${PUBLIC_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000}}
case "${PUBLIC_ORIGIN:-}" in
  *,*) echo 'PUBLIC_ORIGIN must contain a single origin' >&2; exit 1 ;;
esac
# Порти за замовчуванням зникають із браузерного Host. Різні записи того самого
# хоста мають утворити один ключ map, інакше nginx відхилить конфігурацію.
canonical_origins() {
  printf '%s\n' "$1" | LC_ALL=C awk -F, -v mode="$2" '
  NR != 1 || NF == 0 { exit 1 }
  {
    for (i = 1; i <= NF; i++) {
      origin = tolower($i)
      sub(/^[ \t]+/, "", origin)
      sub(/[ \t]+$/, "", origin)
      sub(/\/$/, "", origin)
      if (origin !~ /^https?:\/\/([a-z0-9][a-z0-9.-]*|\[[0-9a-f:]+\])(:[0-9]+)?$/) exit 1
      secure = (origin ~ /^https:/)
      if (mode == "remote" && !secure) exit 1
      host = origin
      sub(/^https?:\/\//, "", host)
      if (match(host, /:[0-9]+$/)) {
        port = substr(host, RSTART + 1) + 0
        if (port < 1 || port > 65535) exit 1
        host = substr(host, 1, RSTART - 1)
        if (port != (secure ? 443 : 80)) host = host ":" port
      }
      key = (secure ? "https://" : "http://") host
      if (!seen[key]++) print key
    }
  }
'
}
if ! normalized_public=$(canonical_origins "$origins" "${DEPLOYMENT_MODE:-local}"); then
  echo 'PUBLIC_ORIGIN(S) must contain valid HTTP origins' >&2
  exit 1
fi
public_hosts=$(printf '%s\n' "$normalized_public" | sed 's|^https*://||')
public_hosts=$(
  for host in $public_hosts; do
    canonical_host "$host" || exit 1
  done
)
public_hosts=$(printf '%s\n' "$public_hosts" | LC_ALL=C awk '!seen[$0]++')
ws=$(printf '%s' "${ENGINE_PUBLIC_WS_URL:-ws://localhost:3001}" | LC_ALL=C tr '[:upper:]' '[:lower:]')
case "$ws" in
  ws://*|http://*) default_port=80 ;;
  wss://*|https://*) default_port=443 ;;
  *) echo 'Invalid public WebSocket URL' >&2; exit 1 ;;
esac
if [ "${DEPLOYMENT_MODE:-local}" = remote ] && [ "$default_port" -ne 443 ]; then
  echo 'Remote WebSocket URL must use TLS' >&2
  exit 1
fi
case "${ws#*://}" in
  *\?*|*\#*|*/*[!/]*) echo 'Invalid public WebSocket URL path' >&2; exit 1 ;;
esac
authority=${ws#*://}
authority=${authority%/}
# Браузер прибирає початкові нулі, а порт за замовчуванням узагалі не надсилає в Host.
if ! authority=$(printf '%s\n' "$authority" | LC_ALL=C awk -v default_port="$default_port" '
  NR != 1 || $0 !~ /^([a-z0-9][a-z0-9.-]*|\[[0-9a-f:]+\])(:[0-9]+)?$/ { exit 1 }
  {
    host = $0
    if (match(host, /:[0-9]+$/)) {
      port = substr(host, RSTART + 1) + 0
      if (port < 1 || port > 65535) exit 1
      host = substr(host, 1, RSTART - 1)
      if (port != default_port) host = host ":" port
    }
    print host
  }
'); then
  echo 'Invalid public WebSocket host' >&2
  exit 1
fi
authority=$(canonical_host "$authority")
temporary=$(mktemp /etc/nginx/conf.d/.public-hosts.XXXXXX)
trap 'rm -f "$temporary"' EXIT
# Цей файл читається до інших map; збільшуємо bucket для довгих коректних DNS-імен.
printf 'map_hash_bucket_size 512;\nmap $http_host $exchange_public_host {\n  default 0;\n' > "$temporary"
for host in $public_hosts; do
  printf '  "%s" 1;\n' "$host" >> "$temporary"
done
printf '}\n' >> "$temporary"
printf 'map $http_host $exchange_ws_host {\n  default 0;\n  "127.0.0.1:3001" 1;\n' >> "$temporary"
if [ "${DEPLOYMENT_MODE:-local}" = local ] && [ "$authority" != localhost:3001 ]; then
  printf '  "localhost:3001" 1;\n' >> "$temporary"
fi
[ "$authority" = 127.0.0.1:3001 ] || printf '  "%s" 1;\n' "$authority" >> "$temporary"
printf '}\nmap "$exchange_public_host:$exchange_ws_host" $exchange_engine_host {\n  default 1;\n  "0:0" 0;\n}\n' >> "$temporary"
mv "$temporary" /etc/nginx/conf.d/10-public-hosts.conf

# CORS використовує канонічні origins, як URL.origin у застосунках.
if ! cors_origins=$(canonical_origins "${CORS_ORIGINS:?CORS_ORIGINS is required}" "${DEPLOYMENT_MODE:-local}"); then
  echo 'CORS_ORIGINS must contain valid HTTP origins' >&2
  exit 1
fi
cors_origins=$(
  for origin in $cors_origins; do
    authority=$(canonical_host "${origin#*://}") || exit 1
    printf '%s://%s\n' "${origin%%://*}" "$authority"
  done
)
cors_origins=$(printf '%s\n' "$cors_origins" | LC_ALL=C awk '!seen[$0]++')
temporary=$(mktemp /etc/nginx/conf.d/.cors-origins.XXXXXX)
printf 'map $http_origin $engine_cors_origin {\n  default "";\n' > "$temporary"
for origin in $cors_origins; do
  printf '  "%s" "%s";\n' "$origin" "$origin" >> "$temporary"
done
printf '}\n' >> "$temporary"
mv "$temporary" /etc/nginx/conf.d/11-cors-origins.conf
