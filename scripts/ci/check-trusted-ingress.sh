#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/../.."

fixture=$(mktemp -d)
prefix="exchange-ingress-$(openssl rand -hex 6)"
image=$(awk '$1 == "image:" && $2 ~ /^nginx:/ {print $2}' docker-compose.yml)
test -n "$image"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$prefix-ingress" || true
    docker logs "$prefix-edge" || true
  fi
  docker rm -f "$prefix-a" "$prefix-b" "$prefix-edge" "$prefix-ingress" >/dev/null 2>&1 || true
  docker network rm "$prefix" >/dev/null 2>&1 || true
  rm -rf "$fixture"
  exit "$status"
}
trap cleanup EXIT
cat > "$fixture/edge.conf" <<'NGINX'
server {
  listen 8080;
  location / {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://trusted-ingress:8080;
  }
}
NGINX
cat > "$fixture/ingress.conf" <<'NGINX'
server {
  listen 8080;
  return 200 "$remote_addr";
}
server {
  listen 8081;
  if ($exchange_public_host = 0) { return 421; }
  return 200 "allowed";
}
server {
  listen 8082;
  if ($exchange_engine_host = 0) { return 421; }
  return 200 "allowed";
}
NGINX
docker network create "$prefix" >/dev/null
docker run -d --name "$prefix-edge" --network "$prefix" --network-alias tls-edge \
  -v "$fixture/edge.conf:/etc/nginx/conf.d/default.conf:ro" "$image" sleep 180 >/dev/null
address() {
  docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}
docker run -d --name "$prefix-ingress" --network "$prefix" --network-alias trusted-ingress \
  -e "TRUSTED_TLS_PROXY_IP=$(address "$prefix-edge")" -e 'NGINX_ENVSUBST_FILTER=^TRUSTED_TLS_PROXY_IP$' \
  -e DEPLOYMENT_MODE=remote -e PUBLIC_ORIGIN=HTTPS://EXCHANGE.Example.Test:443 \
  -e CORS_ORIGINS=https://exchange.example.test \
  -e ENGINE_PUBLIC_WS_URL=WSS://WS.Example.Test:0443/ \
  -e INGRESS_TOKEN=ci-only-ingress-token-value-000001 \
  -e FRONTEND_PROXY_TOKEN=ci-only-frontend-token-value-00001 \
  -v "$PWD/deploy/nginx/real-ip.conf.template:/etc/nginx/templates/real-ip.conf.template:ro" \
  -v "$PWD/deploy/nginx/check-proxy-ip.sh:/docker-entrypoint.d/15-check-proxy-ip.sh:ro" \
  -v "$PWD/deploy/nginx/check-public-origins.sh:/docker-entrypoint.d/16-check-public-origins.sh:ro" \
  -v "$fixture/ingress.conf:/etc/nginx/conf.d/default.conf:ro" "$image" sleep 180 >/dev/null
docker exec "$prefix-ingress" /docker-entrypoint.sh nginx
docker exec "$prefix-edge" nginx
for client in a b; do
  docker run -d --name "$prefix-$client" --network "$prefix" "$image" sleep 180 >/dev/null
done

for client in a b; do
  name="$prefix-$client"
  expected=$(address "$name")
  seen=$(docker exec "$name" wget -qO- --header='X-Forwarded-For: 198.51.100.200' http://tls-edge:8080)
  test "$seen" = "$expected"
  direct=$(docker exec "$name" wget -qO- --header='X-Forwarded-For: 198.51.100.200' http://trusted-ingress:8080)
  test "$direct" = "$expected"
  printf 'Client %s: via trusted proxy %s, direct spoof ignored\n' "$client" "$seen"
done
test "$(address "$prefix-a")" != "$(address "$prefix-b")"

allowed=$(docker exec "$prefix-a" wget -qO- --header='Host: exchange.example.test' http://trusted-ingress:8081)
test "$allowed" = allowed
test "$(docker exec "$prefix-a" wget -qO- --header='Host: ws.example.test' http://trusted-ingress:8082)" = allowed
if rejected=$(docker exec "$prefix-a" wget -SO- --header='Host: ws.example.test' http://trusted-ingress:8081 2>&1); then
  echo 'The frontend listener accepted the separate WebSocket host' >&2
  exit 1
fi
printf '%s\n' "$rejected" | grep -q '421'
docker exec -e DEPLOYMENT_MODE=local -e PUBLIC_ORIGIN= \
  -e 'PUBLIC_ORIGINS= HTTP://LOCALHOST:80, http://localhost, http://LOCALHOST:3000 ' \
  -e ENGINE_PUBLIC_WS_URL=ws://ws.example.test:03001 \
  "$prefix-ingress" /docker-entrypoint.d/16-check-public-origins.sh
docker exec "$prefix-ingress" nginx -t
docker exec "$prefix-ingress" sh -ec '
  test "$(grep -cF \"localhost\" /etc/nginx/conf.d/10-public-hosts.conf)" = 1
  grep -qF \"localhost:3000\" /etc/nginx/conf.d/10-public-hosts.conf
  grep -qF \"ws.example.test:3001\" /etc/nginx/conf.d/10-public-hosts.conf
'
printf 'Public hosts: default port removed, case normalized, duplicates removed, alternate port preserved\n'

docker exec -e DEPLOYMENT_MODE=local -e PUBLIC_ORIGIN= \
  -e 'PUBLIC_ORIGINS=http://[2001:0db8:0:0:0:0:0:1]:0080,http://[2001:db8::1]' \
  -e 'CORS_ORIGINS=http://[2001:0db8:0:0:0:0:0:1]:0080/,http://[2001:db8::1]' \
  -e 'ENGINE_PUBLIC_WS_URL=wss://[2001:0db8:0:0:0:0:0:2]:00443/' \
  "$prefix-ingress" /docker-entrypoint.d/16-check-public-origins.sh
docker exec "$prefix-ingress" nginx -t
docker exec "$prefix-ingress" sh -ec '
  test "$(grep -cF \"[2001:db8::1]\" /etc/nginx/conf.d/10-public-hosts.conf)" = 1
  grep -qF \"[2001:db8::2]\" /etc/nginx/conf.d/10-public-hosts.conf
  test "$(grep -cF http://[2001:db8::1] /etc/nginx/conf.d/11-cors-origins.conf)" = 1
'

if docker exec -e TRUSTED_TLS_PROXY_IP=0.0.0.0/0 "$prefix-ingress" \
  /docker-entrypoint.d/15-check-proxy-ip.sh; then
  echo 'The ingress accepted a universal trusted proxy range' >&2
  exit 1
fi
