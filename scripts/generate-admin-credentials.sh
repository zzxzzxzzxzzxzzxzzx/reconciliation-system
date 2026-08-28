#!/bin/sh
set -eu

username=${1:-admin}

printf '请输入管理员密码（至少 12 个字符）: '
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
  echo "管理员密码至少需要 12 个字符" >&2
  exit 1
fi

ADMIN_PASSWORD="$password" ADMIN_USERNAME_VALUE="$username" node <<'NODE'
const { randomBytes, scryptSync } = require('node:crypto');
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(process.env.ADMIN_PASSWORD, salt, 64).toString('hex');
const secret = randomBytes(32).toString('hex');
console.log(`ADMIN_USERNAME=${process.env.ADMIN_USERNAME_VALUE}`);
console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt}$${hash}`);
console.log(`SESSION_SECRET=${secret}`);
NODE
