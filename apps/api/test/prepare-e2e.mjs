import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const defaultTestDatabaseUrl =
  'postgresql://reconciliation:reconciliation@localhost:55433/reconciliation_test?schema=public';
const databaseUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl;
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');

if (databaseName !== 'reconciliation_test') {
  throw new Error('E2E 测试只能连接 reconciliation_test 数据库');
}

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const apiRoot = resolve(import.meta.dirname, '..');

run('docker', [
  'compose',
  '-p',
  'reconciliation-system',
  'up',
  '-d',
  '--wait',
  'postgres-test',
], repositoryRoot);

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');
run(process.execPath, [prismaCli, 'migrate', 'deploy'], apiRoot, {
  DATABASE_URL: databaseUrl,
});

function run(command, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnvironment },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败，退出码 ${result.status}`);
  }
}
