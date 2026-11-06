#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ ! -s "$1" ]; then
  echo 'Usage: sh scripts/migrate-redis-volume.sh /path/to/dump.rdb' >&2
  exit 1
fi

running_redis=$(docker compose ps --status running -q redis)
if [ -n "$running_redis" ]; then
  echo 'Stop Redis in this Compose project before importing.' >&2
  exit 1
fi

import_script=$(cat <<'SH'
  # One import at a time per volume. The kernel releases the lock when the
  # process dies, including after SIGKILL.
  exec 9</data
  if ! flock -n 9; then
    echo "Another Redis import is using the destination volume." >&2
    exit 1
  fi

  stage=/data/.redis-import
  destination_files=$(ls -A /data | grep -vxF .redis-import || true)
  if [ -n "$destination_files" ]; then
    echo "The destination Redis volume must be empty." >&2
    exit 1
  fi

  # A previous import stopped before it published the AOF.
  rm -rf "$stage"
  mkdir "$stage"
  redis_pid=
  cleanup() {
    if [ -n "$redis_pid" ]; then
      kill "$redis_pid" 2>/dev/null || true
      wait "$redis_pid" || true
    fi
    rm -rf "$stage"
  }
  trap cleanup EXIT
  trap "exit 1" HUP INT TERM

  cat > "$stage/dump.rdb"
  redis-check-rdb "$stage/dump.rdb"
  socket="$stage/redis.sock"
  (
    cd "$stage"
    exec 9<&-
    exec docker-entrypoint.sh redis-server --dir "$stage" --port 0 \
      --unixsocket "$socket" --unixsocketperm 700 --appendonly no --save ""
  ) &
  redis_pid=$!

  timeout 300 sh -ec '
    until redis-cli -e -s "$1" PING 2>/dev/null | grep -qx PONG; do
      kill -0 "$2"
      sleep 1
    done
  ' sh "$socket" "$redis_pid"
  redis-cli -e -s "$socket" CONFIG SET appendonly yes | grep -qx OK
  timeout 300 sh -ec '
    while true; do
      persistence=$(redis-cli -e -s "$1" INFO persistence | tr -d "\r")
      if printf "%s\n" "$persistence" | grep -Eq "^aof_rewrite_(in_progress|scheduled):1$"; then
        sleep 1
        continue
      fi
      printf "%s\n" "$persistence" | grep -qx aof_enabled:1
      printf "%s\n" "$persistence" | grep -qx aof_last_bgrewrite_status:ok
      break
    done
  ' sh "$socket"

  redis-cli -e -s "$socket" SHUTDOWN NOSAVE
  wait "$redis_pid"
  redis_pid=
  test -s "$stage/appendonlydir/appendonly.aof.manifest"
  # Publish the complete AOF in one rename on the destination volume.
  mv -nT "$stage/appendonlydir" /data/appendonlydir
  if [ -e "$stage/appendonlydir" ]; then
    echo "The destination AOF directory already exists." >&2
    exit 1
  fi
  echo "Redis AOF imported. Start Redis with Docker Compose."
SH
)

docker compose run --rm --no-deps -T redis sh -ec "$import_script" < "$1"
