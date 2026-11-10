#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
project="exchange-system-$(openssl rand -hex 6)"
compose() {
  docker compose -p "$project" -f docker-compose.yml -f docker-compose.test.yml "$@"
}
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    compose ps -a || true
    compose logs --no-color --tail=200 || true
  fi
  if ! compose down -v --remove-orphans; then
    if [ "$result" -eq 0 ]; then result=1; fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$#" -eq 0 ]; then
  set -- concurrency chaos:kill after_commit_before_memory relay_after_xadd_before_published \
    settlement_after_commit_before_ack external chaos:pause ws:resync
fi

printf 'Compose project: %s\n' "$project"
compose build system-tests
for scenario; do
  export SYSTEM_CRASH_ENABLED=0
  case "$scenario" in
    concurrency|chaos:kill|chaos:pause|ws:resync) set -- "$scenario" ;;
    after_commit_before_memory|external) set -- chaos:kill -- "$scenario" ;;
    relay_after_xadd_before_published|settlement_after_commit_before_ack)
      export SYSTEM_CRASH_ENABLED=1
      set -- chaos:kill -- "$scenario"
      ;;
    *) printf 'Unknown scenario: %s\n' "$scenario" >&2; exit 2 ;;
  esac
  printf '\n=== %s ===\n' "$scenario"
  compose up -d --build --wait --wait-timeout 240
  compose run --rm --no-deps system-tests npm run "$@"
  compose down -v --remove-orphans
done
