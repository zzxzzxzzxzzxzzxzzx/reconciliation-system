const defaultTestDatabaseUrl =
  'postgresql://reconciliation:reconciliation@localhost:55433/reconciliation_test?schema=public';
const databaseUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl;
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');

if (databaseName !== 'reconciliation_test') {
  throw new Error('E2E 测试只能连接 reconciliation_test 数据库');
}

process.env.DATABASE_URL = databaseUrl;
process.env.AUTH_DISABLED_FOR_TESTS = 'true';
