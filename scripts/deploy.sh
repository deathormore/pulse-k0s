#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="localhost/pulse:1.0.0"
archive="/tmp/pulse-image.tar"

for command in podman k0s helm; do
  command -v "${command}" >/dev/null 2>&1 || { echo "Нет ${command}. Сначала: ./scripts/install-k0s.sh"; exit 1; }
done

echo "1/5 Собираю контейнер приложения"
podman build -t "${image}" "${project_dir}"
rm -f "${archive}"
podman save --format docker-archive -o "${archive}" "${image}"
sudo k0s ctr images import "${archive}"
rm -f "${archive}"

echo "2/5 Разворачиваю PostgreSQL и приложение"
kubectl apply -f "${project_dir}/k8s/base/00-namespace.yaml"
kubectl apply -f "${project_dir}/k8s/base/10-postgres.yaml"
kubectl apply -f "${project_dir}/k8s/base/20-app.yaml"
kubectl -n pulse rollout status statefulset/postgres --timeout=180s
kubectl -n pulse rollout status deployment/pulse-api --timeout=180s
kubectl -n pulse rollout status deployment/pulse-worker --timeout=180s

echo "3/5 Устанавливаю Prometheus и Grafana"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --values "${project_dir}/k8s/monitoring/values.yaml" \
  --wait --timeout 15m

echo "4/5 Подключаю сбор метрик и дашборд"
kubectl apply -f "${project_dir}/k8s/monitoring/servicemonitor.yaml"
kubectl apply -f "${project_dir}/k8s/monitoring/dashboard.yaml"

echo "5/5 Проверяю ресурсы"
kubectl get nodes
kubectl get pods -n pulse
kubectl get pods -n monitoring

vm_ip="$(hostname -I | awk '{print $1}')"
echo
echo "Приложение: http://${vm_ip}:30080"
echo "Grafana: выполни ./scripts/grafana-access.sh и открой http://${vm_ip}:30300"
echo "Логин/пароль Grafana: admin / admin"
