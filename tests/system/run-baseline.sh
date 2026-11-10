#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
repo=$PWD
project="exchange-baseline-$(openssl rand -hex 6)"
scratch=$(mktemp -d /tmp/exchange-baseline.XXXXXX)
tree="$scratch/starter"
baseline() {
  docker compose -p "$project" -f "$tree/docker-compose.yml" -f "$repo/tests/system/baseline/compose.yml" "$@"
}
cleanup() {
  result=$?
  if [ "$result" -ne 0 ] && [ -f "$tree/docker-compose.yml" ]; then
    baseline ps -a || true
    baseline logs --no-color --tail=200 || true
  fi
  containers=$(docker ps -aq --filter "label=exchange.system.baseline=$project") || result=1
  if [ -n "$containers" ]; then
    while IFS= read -r id; do docker rm -f "$id" || true; done <<< "$containers"
  fi
  if [ -f "$tree/docker-compose.yml" ]; then
    if ! baseline down -v --remove-orphans; then
      if [ "$result" -eq 0 ]; then result=1; fi
    fi
  fi
  if [ -d "$tree" ]; then git worktree remove --force "$tree" || result=1; fi
  rmdir "$scratch" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git worktree add --detach "$tree" starter-baseline
git -C "$tree" apply "$repo/tests/system/baseline/build-only.patch"
docker compose -p "$project-fixed" -f docker-compose.yml -f docker-compose.test.yml build matching-engine-1 system-tests
baseline up -d --build --wait --wait-timeout 240 exchange-db redis matching-engine-service
starter_image=$(baseline images -q matching-engine-service)
docker run --rm --label "exchange.system.baseline=$project" --network "${project}_default" \
  -v /var/run/docker.sock:/var/run/docker.sock "$project-fixed-system-tests" \
  npm run baseline -- "$project" "$starter_image" "$project-fixed-matching-engine-1"
