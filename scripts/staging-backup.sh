#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="${1:-$project_dir/.env.staging}"
compose_file="$project_dir/compose.staging.yaml"
backup_dir="$project_dir/backups"

if [ ! -f "$env_file" ]; then
  echo "缺少环境文件: $env_file" >&2
  exit 1
fi

mkdir -p "$backup_dir"
timestamp=$(date '+%Y%m%d-%H%M%S')
backup_file="$backup_dir/reconciliation-staging-$timestamp.sql.gz"

docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$backup_file"

echo "数据库备份已生成: $backup_file"
