import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, scryptSync } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const password = 'AuthTestPassword!2026';
const salt = randomBytes(16).toString('hex');

describe('管理员登录', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_DISABLED_FOR_TESTS = 'false';
    process.env.ADMIN_USERNAME = 'test-admin';
    process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
    process.env.SESSION_SECRET = randomBytes(32).toString('hex');
    process.env.COOKIE_SECURE = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.AUTH_DISABLED_FOR_TESTS = 'true';
  });

  it('未登录不能访问业务接口，但健康检查公开', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/imports').expect(401, {
      statusCode: 401,
      message: '请先登录',
      error: 'Unauthorized',
    });
  });

  it('正确密码登录后可以查询会话并退出', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/auth/login').send({
      username: 'test-admin',
      password,
    }).expect(201, { authenticated: true, username: 'test-admin' });
    expect(login.headers['set-cookie']?.[0]).toContain('reconciliation_session=');
    expect(login.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(login.headers['set-cookie']?.[0]).toContain('SameSite=Strict');

    await agent.get('/auth/session').expect(200, {
      authenticated: true,
      username: 'test-admin',
    });
    await agent.post('/auth/logout').expect(201, { authenticated: false });
    await agent.get('/auth/session').expect(401);
  });

  it('连续失败五次后临时锁定登录', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post('/auth/login').send({
        username: 'test-admin',
        password: 'wrong-password',
      }).expect(401, {
        statusCode: 401,
        message: '用户名或密码不正确',
        error: 'Unauthorized',
      });
    }

    await request(app.getHttpServer()).post('/auth/login').send({
      username: 'test-admin',
      password,
    }).expect(401, {
      statusCode: 401,
      message: '登录失败次数过多，请 15 分钟后再试',
      error: 'Unauthorized',
    });
  });
});
