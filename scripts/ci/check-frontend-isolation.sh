#!/usr/bin/env bash
# Читає конфігурацію й відкриває лише TCP-з'єднання з дедлайном; стан сервісів не змінює.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose config --format json | jq -e '.services.frontend.networks | keys == ["frontend"]'
# Адреси бекендів у всіх їхніх мережах беремо на хості: перевірка маршрутизації не залежить від
# DNS усередині frontend.
targets=
for pair in redis:6379 exchange-db:5432 matching-engine-1:3001 settlement-service:3002; do
  service=${pair%%:*}
  addresses=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
    "$(docker compose ps -q "$service")")
  test -n "${addresses// /}"
  for address in $addresses; do targets="$targets $service=$address:${pair##*:}"; done
done
docker compose exec -T -e TARGETS="$targets" frontend node <<'JS'
const dns = require('node:dns');
const net = require('node:net');
const fail = (message) => { throw new Error(message); };
async function main() {
  // Спершу дозволений шлях: DNS-запити неіснуючих імен займають пул потоків libuv, і fetch
  // чекав би за ними.
  const routes = ['/metrics', '/docs', '/docs-json'];
  for (const path of routes) {
    let response;
    try {
      response = await fetch('http://engine-lb:8080' + path, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      fail(`engine-lb:8080${path}: ${error.message}`);
    }
    await response.body?.cancel();
    if (response.status !== 404) fail(`Unexpected status for ${path}: ${response.status}`);
  }
  const targets = process.env.TARGETS.trim().split(/\s+/).map((entry) => {
    const [service, address] = entry.split('=');
    const [host, port] = address.split(':');
    return { service, host, port: Number(port) };
  });
  await Promise.all(targets.map(({ service, host, port }) => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Frontend can reach ${service} at ${host}:${port}`)); });
    socket.once('error', () => resolve());
    socket.setTimeout(2000, () => { socket.destroy(); resolve(); });
  })));
  const names = [...new Set(targets.map(({ service }) => service))];
  for (const name of names) {
    const found = await dns.promises.lookup(name).then(({ address }) => address, () => undefined);
    if (found) fail(`Frontend resolves ${name} to ${found}`);
  }
  console.log(`Frontend isolation: ${targets.length} backend addresses, ${names.length} names and ${routes.length} private routes blocked`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
JS
