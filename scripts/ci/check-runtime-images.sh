#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

scanner=aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
logs=${IMAGE_AUDIT_LOG_DIR:-$scratch/reports}
mkdir -p "$scratch/cache" "$logs"
# Завантаження бази не має доступу до образів чи Docker socket.
docker run --rm -v "$scratch/cache:/cache" "$scanner" image \
  --cache-dir /cache --download-db-only --no-progress

for service in matching-engine-1 settlement-service frontend engine-lb; do
  id=$(docker compose ps -q "$service")
  test -n "$id"
  image=$(docker inspect --format '{{.Image}}' "$id")
  docker save -o "$scratch/image.tar" "$image"
  docker run --rm --network none --tmpfs /cache \
    -v "$scratch/cache/db:/cache/db:ro" -v "$scratch/image.tar:/image.tar:ro" \
    "$scanner" image --cache-dir /cache --offline-scan --skip-db-update --skip-java-db-update \
    --scanners vuln --input /image.tar --format json > "$logs/$service.json"
  rm "$scratch/image.tar"
done
python3 scripts/ci/check-image-reports.py "$logs"
