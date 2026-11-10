#!/bin/sh
set -eu

# Приймаємо одну адресу, щоб конфігурація nginx не довіряла цілій підмережі.
case "${TRUSTED_TLS_PROXY_IP:-}" in
  ''|*[!0-9a-fA-F:.]*|0.0.0.0|::)
    echo 'TRUSTED_TLS_PROXY_IP must be a single IPv4 or IPv6 address' >&2
    exit 1
    ;;
esac
case "$TRUSTED_TLS_PROXY_IP" in
  *:*) ;;
  *[!0-9.]*)
    echo 'TRUSTED_TLS_PROXY_IP must be a single IPv4 or IPv6 address' >&2
    exit 1
    ;;
esac
