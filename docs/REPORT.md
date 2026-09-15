# Отчёт о выполнении

## 1. Параметры стенда

- гипервизор: VMware;
- операционная система: Ubuntu Server 24.04.5 LTS;
- CPU: 2+ vCPU;
- RAM: 8 ГБ;
- сеть VM: NAT;
- IP стенда во время выполнения: `192.168.21.133`.

## 2. Установка k0s

Обновлены системные пакеты и установлены инструменты загрузки:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y curl ca-certificates
```

k0s установлен официальным скриптом:

```bash
curl -sSLf https://get.k0s.sh | sudo sh
k0s version
```

Полученная версия: `v1.36.4+k0s.0`.

Создан и запущен single-node кластер. Флаг `--single` совмещает роли control plane и worker на одной VM:

```bash
sudo k0s install controller --single
sudo k0s start
sudo k0s status
sudo k0s kubectl get nodes -o wide
```

Результат: нода `study` перешла в состояние `Ready`, workloads разрешены, Kubernetes API доступен.

![Состояние k0s и Kubernetes-ноды](images/k0s-node.png)

## 3. Сборка контейнерного образа

Для сборки установлен Podman:

```bash
sudo apt install -y podman
podman --version
```

Образ собран по Dockerfile:

```bash
podman build -t localhost/pulse:1.0.0 .
podman images localhost/pulse
```

Так как Podman и containerd k0s используют разные image stores, образ экспортирован и импортирован вручную:

```bash
podman save --format docker-archive \
  -o /tmp/pulse-image.tar \
  localhost/pulse:1.0.0

sudo k0s ctr images import /tmp/pulse-image.tar
sudo k0s ctr images list | grep pulse
```

## 4. Развёртывание Pulse

Создан отдельный namespace:

```bash
sudo k0s kubectl apply -f k8s/base/00-namespace.yaml
sudo k0s kubectl get namespace pulse
```

Развёрнут PostgreSQL:

```bash
sudo k0s kubectl apply -f k8s/base/10-postgres.yaml
sudo k0s kubectl get pods -n pulse -w
```

Манифест создаёт:

- Secret с реквизитами БД;
- статический PersistentVolume на 4 ГБ;
- PersistentVolumeClaim;
- headless Service `postgres`;
- PostgreSQL StatefulSet.

Развёрнуты API и checker-worker:

```bash
sudo k0s kubectl apply -f k8s/base/20-app.yaml
sudo k0s kubectl get pods -n pulse -w
```

Итоговое состояние:

```text
pulse-api      2/2 available
pulse-worker   1/1 available
postgres       1/1 ready
postgres-data  Bound, 4 GiB
```

![Workload и постоянное хранилище Pulse](images/pulse-workloads.png)

API опубликован через NodePort `30080`:

```bash
curl -fsS http://127.0.0.1:30080/readyz
```

Ответ `{"status":"ready"}` подтвердил доступность API и PostgreSQL.

## 5. Мониторинг

Для доступа Helm к кластеру создан kubeconfig:

```bash
mkdir -p ~/.kube
sudo k0s kubeconfig admin > ~/.kube/config
chmod 600 ~/.kube/config
```

Установлен Helm 3 и добавлен официальный репозиторий Prometheus Community:

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \
  -o /tmp/get-helm.sh
chmod 700 /tmp/get-helm.sh
/tmp/get-helm.sh

helm repo add prometheus-community \
  https://prometheus-community.github.io/helm-charts
helm repo update
```

Установлен `kube-prometheus-stack`:

```bash
helm upgrade --install monitoring \
  prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --values k8s/monitoring/values.yaml \
  --wait \
  --timeout 15m
```

Подключены метрики API и worker, загружен dashboard:

```bash
sudo k0s kubectl apply -f k8s/monitoring/servicemonitor.yaml
sudo k0s kubectl apply -f k8s/monitoring/dashboard.yaml
```

Grafana dashboard отображает:

- число доступных targets;
- открытые инциденты;
- API requests/sec;
- p95 latency API;
- latency проверяемых сервисов;
- успешные и неуспешные проверки;
- timeline доступности;
- распределение HTTP-кодов.

![Компоненты мониторинга и ServiceMonitor](images/monitoring-workloads.png)

## 6. Эксперимент с отказом

В кластер добавлен тестовый Nginx:

```bash
sudo k0s kubectl apply -f k8s/demo/demo-web.yaml
```

Pulse проверял его по внутреннему Kubernetes DNS:

```text
http://demo-web.pulse.svc.cluster.local
```

Для имитации сбоя число реплик уменьшено до нуля:

```bash
sudo k0s kubectl scale deployment demo-web --replicas=0 -n pulse
```

Pulse зафиксировал `OUTAGE`, timeout 8000 мс и снижение uptime. В интерфейсе создан critical incident, а Grafana показала неуспешные проверки и один открытый инцидент.

Сервис восстановлен:

```bash
sudo k0s kubectl scale deployment demo-web --replicas=1 -n pulse
sudo k0s kubectl rollout status deployment/demo-web -n pulse
```

После восстановления Pulse вернул статус `OPERATIONAL`, инцидент был закрыт.

## 7. Проверка self-healing и persistence

Удаление одного API pod подтвердило, что Deployment автоматически восстанавливает две реплики, а Service продолжает обслуживать запросы через оставшийся pod.

```bash
sudo k0s kubectl delete pod <PULSE_API_POD> -n pulse
sudo k0s kubectl get pods -n pulse -l app=pulse-api -w
```

Удаление PostgreSQL pod подтвердило восстановление StatefulSet и сохранность данных:

```bash
sudo k0s kubectl delete pod postgres-0 -n pulse
sudo k0s kubectl get pods -n pulse -w
```

После пересоздания pod сервисы, история и инциденты остались в БД благодаря PersistentVolume.

Таблицы PostgreSQL проверены напрямую:

```bash
sudo k0s kubectl exec -n pulse postgres-0 -- \
  psql -U pulse -d pulse -c '\dt'
```

Созданы таблицы `services`, `checks`, `incidents`, `incident_updates`, `deployments` и `maintenance`.

![Таблицы PostgreSQL](images/postgres-tables.png)

## 8. Мониторинг кластера

В дополнение к метрикам Pulse создан отдельный dashboard состояния k0s. Он использует данные `kube-state-metrics` и `node-exporter` и показывает готовность ноды и pod, реплики Deployment, состояние PostgreSQL и PVC, рестарты контейнеров, CPU, RAM и диск.

Готовый JSON для импорта хранится в `k8s/monitoring/cluster-dashboard.json`.

## 9. Внешние бэкапы

PostgreSQL копируется ежедневным Kubernetes CronJob в Yandex Object Storage. Backup Job создаёт custom-format dump, загружает объект через S3 API и проверяет его командой `head-object`.

Хранилище не смонтировано в приложение и не участвует в runtime Pulse. Для префикса `postgres/` настроено удаление объектов старше 14 дней.

Отдельный S3-checker каждые пять минут считает фактические объекты в бакете и отправляет метрику `pulse_s3_backup_objects` в Pushgateway. Prometheus собирает её, а Grafana отображает количество сохранённых бэкапов.

Подробная реализация и команды проверки: [CLUSTER-MONITORING-AND-BACKUPS.md](CLUSTER-MONITORING-AND-BACKUPS.md).

## 10. Результат

Цель работы достигнута: на локальной Ubuntu VM развёрнут k0s, создано и контейнеризировано приложение с PostgreSQL и интерактивным интерфейсом, настроены Prometheus и Grafana, проведены тесты отказа, self-healing и сохранности данных. Дополнительно реализованы мониторинг Kubernetes-кластера, регулярные внешние бэкапы и контроль фактического количества backup-файлов в Object Storage.
