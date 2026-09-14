#!/usr/bin/env bash
set -Eeuo pipefail

vm_ip="$(hostname -I | awk '{print $1}')"
echo "Grafana будет доступна по http://${vm_ip}:30300 (Ctrl+C — остановить доступ)"
kubectl -n monitoring port-forward --address 0.0.0.0 service/monitoring-grafana 30300:80
