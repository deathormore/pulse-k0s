#!/usr/bin/env bash
set -Eeuo pipefail

base_url="${1:-http://127.0.0.1:30080}"
echo "Генерирую запросы к ${base_url}. Ctrl+C — остановить."
while true; do
  curl -fsS "${base_url}/api/overview" >/dev/null || true
  curl -fsS "${base_url}/healthz" >/dev/null || true
  sleep 0.2
done
