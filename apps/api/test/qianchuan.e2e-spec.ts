import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('千川消耗', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('导入时跳过总计行，并支持账号日期查询和汇总', async () => {
    const suffix = Date.now();
    const testYear = 2100 + (suffix % 700);
    const testMonth = String((suffix % 9) + 1).padStart(2, '0');
    const csv = [
      '日期,余额总消耗(元),非赠款消耗(元),赠款消耗(元),消返红包消耗(元),立减红包消耗(元),共享钱包消耗(元),共享赠款消耗(元),测试标识',
      '总计,999,999,0,0,0,0,0',
      `${testYear}-${testMonth}-01,12.30,10.00,2.30,0,0,0,0,${suffix}`,
      `${testYear}-${testMonth}-02,8.70,8.70,0,0,0,0,0,${suffix}`,
    ].join('\n');

    const imported = await request(app.getHttpServer())
      .post('/qianchuan/import?accountName=百香果01')
      .attach('file', Buffer.from(csv, 'utf8'), `qianchuan-${suffix}.csv`)
      .expect(201);

    expect(imported.body).toMatchObject({ duplicate: false, accountName: '百香果01', batch: { successRows: 2, failedRows: 0 } });

    const list = await request(app.getHttpServer())
      .get(`/qianchuan?accountName=%E7%99%BE%E9%A6%99%E6%9E%9C01&from=${testYear}-${testMonth}-02&to=${testYear}-${testMonth}-02&page=1&pageSize=20`)
      .expect(200);
    expect(list.body).toMatchObject({ total: 1, totalPages: 1 });
    expect(list.body.items[0]).toMatchObject({ accountName: '百香果01', totalSpend: '8.70', spendDate: `${testYear}-${testMonth}-02T00:00:00.000Z` });

    const summary = await request(app.getHttpServer())
      .get(`/qianchuan/summary?accountName=%E7%99%BE%E9%A6%99%E6%9E%9C01&from=${testYear}-${testMonth}-01&to=${testYear}-${testMonth}-02`)
      .expect(200);
    expect(summary.body).toMatchObject({ rowCount: 2, totalSpend: '21.00', nonGiftSpend: '18.70', giftSpend: '2.30' });

    const exported = await request(app.getHttpServer())
      .get(`/qianchuan/export?accountName=%E7%99%BE%E9%A6%99%E6%9E%9C01&from=${testYear}-${testMonth}-01&to=${testYear}-${testMonth}-02`)
      .expect(200);
    expect(exported.text).toContain('"百香果01"');
    expect(exported.text).not.toContain('999');
  });

  it('没有日期或总消耗表头时拒绝导入', async () => {
    const response = await request(app.getHttpServer())
      .post('/qianchuan/import?accountName=朱颜')
      .attach('file', Buffer.from(`日期,其他\n2026-07-01,${Date.now()}`, 'utf8'), `qianchuan-invalid-${Date.now()}.csv`)
      .expect(400);
    expect(response.body.message).toContain('文件格式不符合千川消耗表要求');
    expect(response.body.batchId).toEqual(expect.any(String));
  });
});
