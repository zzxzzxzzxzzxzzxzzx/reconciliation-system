#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <用户名>" >&2
  exit 1
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
auth_file="$project_dir/deploy/nginx/.htpasswd"
username=$1

printf '请输入测试环境访问密码: '
if [ -t 0 ]; then
  stty -echo
  trap 'stty echo 2>/dev/null || true' EXIT HUP INT TERM
fi
IFS= read -r password
if [ -t 0 ]; then
  stty echo
  trap - EXIT HUP INT TERM
fi
printf '\n'

if [ "${#password}" -lt 12 ]; then
  echo "密码至少需要 12 个字符" >&2
  exit 1
fi

password_hash=$(printf '%s\n' "$password" | openssl passwd -apr1 -stdin)
printf '%s:%s\n' "$username" "$password_hash" > "$auth_file"
chmod 600 "$auth_file"
echo "测试环境访问账号已写入 $auth_file"
