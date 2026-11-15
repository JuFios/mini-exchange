#!/usr/bin/env bash
# Читає конфігурацію й відкриває лише TCP-з'єднання з дедлайном; стан сервісів не змінює.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose config --format json | jq -e '.services.frontend.networks | keys == ["frontend"]'
docker compose exec -T frontend node <<'JS'
const net = require('node:net');
const targets = [['redis',6379], ['exchange-db',5432], ['matching-engine-1',3001], ['settlement-service',3002]];
const tcp = Promise.all(targets.map(([host,port]) => new Promise((resolve,reject) => {
  const socket = net.createConnection({host,port});
  socket.once('connect', () => { socket.destroy(); reject(new Error(`Frontend can reach ${host}:${port}`)); });
  socket.once('error', () => resolve(host));
  socket.setTimeout(2000, () => { socket.destroy(); resolve(host); });
})));
const routes = ['/metrics', '/docs', '/docs-json'];
const http = Promise.all(routes.map(async path => {
  const response = await fetch('http://engine-lb:8080' + path, { signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  if (response.status !== 404) throw new Error(`Unexpected status for ${path}: ${response.status}`);
}));
Promise.all([tcp, http]).then(([blocked]) => console.log(`Frontend isolation: ${blocked.length}/4 backend targets and ${routes.length}/3 private routes blocked`))
  .catch((error) => { console.error(error.message); process.exitCode=1; });
JS
