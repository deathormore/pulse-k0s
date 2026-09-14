#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -eq 0 ]]; then
  echo "Запусти скрипт обычным пользователем с sudo, не из root-shell."
  exit 1
fi

sudo apt-get update
sudo apt-get install -y curl ca-certificates podman

if ! command -v k0s >/dev/null 2>&1; then
  curl -sSLf https://get.k0s.sh | sudo sh
fi

if ! sudo systemctl is-active --quiet k0scontroller 2>/dev/null; then
  if ! sudo test -f /etc/systemd/system/k0scontroller.service; then
    sudo k0s install controller --single
  fi
  sudo k0s start
fi

echo "Жду готовности Kubernetes-ноды…"
sudo k0s kubectl wait --for=condition=Ready node --all --timeout=180s

mkdir -p "${HOME}/.kube"
sudo k0s kubeconfig admin | sed 's#server: https://localhost:#server: https://127.0.0.1:#' > "${HOME}/.kube/config"
chmod 600 "${HOME}/.kube/config"

if ! command -v helm >/dev/null 2>&1; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' EXIT
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 -o "${tmp_dir}/get_helm.sh"
  chmod 700 "${tmp_dir}/get_helm.sh"
  "${tmp_dir}/get_helm.sh"
fi

echo "Готово: $(k0s version), $(helm version --short), $(podman --version)"
