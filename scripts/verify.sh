#!/usr/bin/env bash
set -Eeuo pipefail

echo "=== Node ==="
kubectl get nodes -o wide
echo "=== Pulse ==="
kubectl get all,pvc -n pulse
echo "=== Probes ==="
curl -fsS http://127.0.0.1:30080/healthz && echo
curl -fsS http://127.0.0.1:30080/readyz && echo
echo "=== Metrics sample ==="
curl -fsS http://127.0.0.1:30080/metrics | grep '^pulse_http_requests_total' | head
echo "=== ServiceMonitor ==="
kubectl get servicemonitor -n pulse
