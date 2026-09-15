#!/bin/sh
set -eu

timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
backup_file="/tmp/pulse-${timestamp}.dump"
object_key="postgres/pulse-${timestamp}.dump"

trap 'rm -f "$backup_file"' EXIT

export PGPASSWORD="$DB_PASSWORD"

echo "Creating PostgreSQL backup..."

pg_dump \
  --host="$DB_HOST" \
  --port="${DB_PORT:-5432}" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --format=custom \
  --file="$backup_file"

echo "Uploading backup to s3://${S3_BUCKET}/${object_key}..."

aws \
  --endpoint-url="$S3_ENDPOINT" \
  s3 cp "$backup_file" "s3://${S3_BUCKET}/${object_key}" \
  --no-progress

echo "Verifying uploaded object..."

aws \
  --endpoint-url="$S3_ENDPOINT" \
  s3api head-object \
  --bucket="$S3_BUCKET" \
  --key="$object_key" >/dev/null

echo "Backup completed successfully: ${object_key}"
