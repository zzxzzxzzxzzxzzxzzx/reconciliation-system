#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="${1:-$project_dir/.env.staging}"
compose_file="$project_dir/compose.staging.yaml"

if [ ! -f "$env_file" ]; then
  echo "缺少环境文件: $env_file，请先复制并修改 .env.staging.example" >&2
  exit 1
fi
docker compose --env-file "$env_file" -f "$compose_file" config --quiet
docker compose --env-file "$env_file" -f "$compose_file" up -d --build
docker compose --env-file "$env_file" -f "$compose_file" ps
