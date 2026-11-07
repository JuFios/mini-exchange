#!/usr/bin/env bash
# Перевіряє прив’язку портів у локальному й віддаленому запуску Compose та відмову
# віддаленого запуску без секретів. Лише `docker compose config`: нічого не стартує
# і не змінює, тож скрипт безпечно запускати повторно й паралельно.
set -eu

cd "$(dirname "$0")/../.."

# Значення лише для цієї перевірки, не для запуску.
CI_ACCESS_SECRET=ci-only-access-secret-value-000001
CI_REFRESH_SECRET=ci-only-refresh-secret-value-00001
export ADMIN_EMAILS=ci-admin@example.test
export ADMIN_PASSWORD=ci-only-admin-password-000001
export NEXT_PUBLIC_WS_URL=wss://exchange.example.test

docker compose config --format json | jq -e '
  .services as $s |
  ($s["matching-engine-service"].ports | length == 1 and .[0].host_ip == "127.0.0.1") and
  ($s.frontend.ports | length == 1 and .[0].host_ip == "127.0.0.1")'
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
JWT_ACCESS_SECRET="$CI_ACCESS_SECRET" JWT_REFRESH_SECRET="$CI_REFRESH_SECRET" remote config --format json |
  jq -e --arg access "$CI_ACCESS_SECRET" --arg refresh "$CI_REFRESH_SECRET" \
    --arg admin "$ADMIN_EMAILS" --arg password "$ADMIN_PASSWORD" '
    .services as $s |
    ($s["matching-engine-service"].environment |
      .JWT_ACCESS_SECRET == $access and .JWT_REFRESH_SECRET == $refresh and
      .ADMIN_EMAILS == $admin and .ADMIN_PASSWORD == $password) and
    ($s["engine-migrate"].ports // [] | length == 0) and
    ($s["matching-engine-service"].ports | length == 1 and .[0].host_ip == null) and
    ($s.frontend.ports | length == 1 and .[0].host_ip == null)'
