import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma.service';

describe('订单标准化', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('将批次原始记录标准化为主订单和商品明细，重复执行幂等', async () => {
    const mainOrderNo = `79${Date.now()}`;
    const csv = [
      '主订单编号,子订单编号,选购商品,商品ID,商家编码,商品数量,商品金额,订单应付金额,商家收入金额,订单提交时间,订单状态,支付方式',
      `${mainOrderNo},${mainOrderNo},测试商品-(TEST01),1001,TEST01,1,69.00,69.00,69.00,2026-08-01 10:00:00,已发货,抖音支付`,
      // 数量合计 5 拆到 2 行，无法分摊，应保留问题
      `${mainOrderNo}M,${mainOrderNo}M1;${mainOrderNo}M2,商品A-(A01);商品B-(B02),2001;2002,A01;B02,5,108.90,58.90,108.90,2026-08-01 11:00:00,已发货,抖音支付`,
      // 数量合计 2 拆到 2 行，每行必为 1 件，可直接回填
      `${mainOrderNo}I,${mainOrderNo}I1;${mainOrderNo}I2,商品C-(C01);商品D-(D02),3001;3002,C01;D02,2,88.00,88.00,88.00,2026-08-01 12:00:00,已发货,抖音支付`,
    ].join('\n');

    const uploadResponse = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), 'std-orders.csv')
      .expect(201);
    const batchId = uploadResponse.body.batch.id;

    const standardizeResponse = await request(app.getHttpServer())
      .post(`/orders/standardize/${batchId}`)
      .expect(201);

    expect(standardizeResponse.body).toMatchObject({
      batchId,
      orderCount: 3,
      itemCount: 5,
      issueCount: 1,
    });

    const orderResponse = await request(app.getHttpServer())
      .get(`/orders/${mainOrderNo}`)
      .expect(200);

    expect(orderResponse.body).toMatchObject({
      mainOrderNo,
      status: '已发货',
      sourceFileName: 'std-orders.csv',
      rowNumber: 2,
    });
    expect(Number(orderResponse.body.payableAmount)).toBe(69);
    expect(orderResponse.body.items).toHaveLength(1);
    expect(orderResponse.body.items[0]).toMatchObject({
      productId: '1001',
      merchantCode: 'TEST01',
      skuCode: 'TEST01',
      quantity: 1,
    });
    expect(Number(orderResponse.body.items[0].productAmount)).toBe(69);

    const multiResponse = await request(app.getHttpServer())
      .get(`/orders/${mainOrderNo}M`)
      .expect(200);
    expect(multiResponse.body.items).toHaveLength(2);
    expect(multiResponse.body.items[0].quantity).toBeNull();
    expect(multiResponse.body.totalQuantity).toBe(5);

    const inferableResponse = await request(app.getHttpServer())
      .get(`/orders/${mainOrderNo}I`)
      .expect(200);
    expect(inferableResponse.body.items).toHaveLength(2);
    expect(inferableResponse.body.items[0].quantity).toBe(1);
    expect(inferableResponse.body.items[1].quantity).toBe(1);
    expect(inferableResponse.body.totalQuantity).toBe(2);

    const issuesResponse = await request(app.getHttpServer())
      .get('/orders/issues')
      .expect(200);
    const relatedIssues = issuesResponse.body.filter(
      (issue: { mainOrderNo?: string }) => issue.mainOrderNo === `${mainOrderNo}M`,
    );
    expect(relatedIssues).toHaveLength(1);
    expect(relatedIssues[0].issueType).toBe('SPLIT_AMBIGUOUS');
    const inferableIssues = issuesResponse.body.filter(
      (issue: { mainOrderNo?: string }) => issue.mainOrderNo === `${mainOrderNo}I`,
    );
    expect(inferableIssues).toHaveLength(0);

    const repeatResponse = await request(app.getHttpServer())
      .post(`/orders/standardize/${batchId}`)
      .expect(201);
    expect(repeatResponse.body).toMatchObject({
      orderCount: 3,
      itemCount: 5,
      issueCount: 1,
    });

    const listResponse = await request(app.getHttpServer())
      .get('/orders?page=1&pageSize=5')
      .expect(200);
    expect(listResponse.body.items.length).toBeGreaterThan(0);
    expect(listResponse.body.items[0]).toHaveProperty('settledAmount');
    expect(listResponse.body.items[0]).toHaveProperty('costAmount');
    expect(listResponse.body.items[0]).toHaveProperty('profit');
  });

  it('查询不存在的订单返回 404', async () => {
    await request(app.getHttpServer()).get('/orders/not-exist-order').expect(404);
  });

  it('商品 ID 缺失时记录独立问题', async () => {
    const mainOrderNo = `78${Date.now()}`;
    const csv = [
      '主订单编号,子订单编号,选购商品,商家编码,商品数量,商品金额',
      `${mainOrderNo},${mainOrderNo},无商品ID商品,TEST-MISSING,1,10`,
    ].join('\n');
    const upload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), `missing-product-${Date.now()}.csv`)
      .expect(201);
    const standardized = await request(app.getHttpServer())
      .post(`/orders/standardize/${upload.body.batch.id}`)
      .expect(201);
    expect(standardized.body.issueCount).toBeGreaterThanOrEqual(1);
    const issues = await request(app.getHttpServer()).get(`/orders/issues?orderBatchId=${upload.body.batch.id}`).expect(200);
    expect(issues.body.some((issue: { issueType: string }) => issue.issueType === 'PRODUCT_ID_MISSING')).toBe(true);
  });

  it('标准化不存在的批次返回 404', async () => {
    await request(app.getHttpServer())
      .post('/orders/standardize/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('不会把订单批次以外的失败行生成空订单', async () => {
    const csv = ['主订单编号,子订单编号,商品ID', ',,P-EMPTY', 'ORDER-VALID,ORDER-VALID,P-VALID'].join('\n');
    const upload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), `empty-order-${Date.now()}.csv`)
      .expect(201);
    const result = await request(app.getHttpServer())
      .post(`/orders/standardize/${upload.body.batch.id}`)
      .expect(201);
    expect(result.body.orderCount).toBe(1);
    const orders = await request(app.getHttpServer()).get('/orders').query({ batchId: upload.body.batch.id }).expect(200);
    expect(orders.body.items).toHaveLength(1);
    expect(orders.body.items[0].mainOrderNo).toBe('ORDER-VALID');
  });

  it('汇总不会把旧批次挂在当前订单上的未结算问题重复计算', async () => {
    const mainOrderNo = `77${Date.now()}`;
    const csv = [
      '主订单编号,子订单编号,商品ID,商品数量,商品金额',
      `${mainOrderNo},${mainOrderNo},P-SUMMARY,1,10`,
    ].join('\n');
    const upload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), `summary-issue-${Date.now()}.csv`)
      .expect(201);
    const batchId = upload.body.batch.id as string;
    await request(app.getHttpServer()).post(`/orders/standardize/${batchId}`).expect(201);
    const orders = await request(app.getHttpServer()).get('/orders').query({ batchId }).expect(200);
    const orderId = orders.body.items[0].id as string;

    await app.get(PrismaService).orderIssue.create({
      data: {
        issueType: 'ORDER_WITHOUT_SETTLEMENT',
        mainOrderNo,
        orderId,
        message: '旧批次遗留问题',
        batchId: randomUUID(),
      },
    });
    await app.get(PrismaService).orderIssue.create({
      data: {
        issueType: 'PRODUCT_UNMATCHED',
        mainOrderNo,
        orderId,
        message: '缺成本的内部匹配原因',
        batchId,
      },
    });

    const summary = await request(app.getHttpServer())
      .get('/orders/summary')
      .query({ orderBatchId: batchId })
      .expect(200);
    expect(summary.body.issueCount).toBe(0);
    expect(summary.body.issueCounts).toEqual({});
  });

  it('按对账月份合并已完成任务，并对重复订单和结算批次去重', async () => {
    const suffix = Date.now();
    const accountingMonth = `${3000 + Math.floor(suffix / 12) % 6000}-${String(suffix % 12 + 1).padStart(2, '0')}`;
    const orderNo = `9${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `${orderNo},${orderNo},MONTH-P-${suffix},MONTH-SKU-${suffix},月份汇总商品,1,10.00,2026-07-01 10:00:00`,
    ].join('\n');
    const firstOrderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv), `monthly-orders-first-${suffix}.csv`)
      .expect(201);
    const orderBatchId = firstOrderUpload.body.batch.id as string;
    await request(app.getHttpServer()).post(`/orders/standardize/${orderBatchId}`).expect(201);

    const duplicateOrderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv), `monthly-orders-duplicate-${suffix}.csv`)
      .expect(201);
    const settlementCsv = [
      '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
      `2026-07-02 10:00:00,'${orderNo},'${orderNo},7.00,聚合账户,首笔结算`,
    ].join('\n');
    const firstSettlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from(settlementCsv), `monthly-settlement-first-${suffix}.csv`)
      .expect(201);
    const settlementBatchId = firstSettlementUpload.body.batch.id as string;
    const secondSettlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from([
        '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
        `2026-07-03 10:00:00,'${orderNo},'${orderNo},3.00,聚合账户,补充结算`,
      ].join('\n'), 'utf8'), `monthly-settlement-second-${suffix}.csv`)
      .expect(201);
    const secondSettlementBatchId = secondSettlementUpload.body.batch.id as string;

    const firstTask = await request(app.getHttpServer()).post('/reconciliation-tasks').send({
      accountingMonth,
      orderBatchId,
      settlementBatchId,
    }).expect(201);
    await request(app.getHttpServer()).post(`/reconciliation-tasks/${firstTask.body.id}/run`).expect(201);

    const secondTask = await request(app.getHttpServer()).post('/reconciliation-tasks').send({
      accountingMonth,
      orderBatchId: duplicateOrderUpload.body.batch.id,
      settlementBatchId: secondSettlementBatchId,
    }).expect(201);
    await request(app.getHttpServer()).post(`/reconciliation-tasks/${secondTask.body.id}/run`).expect(201);

    const monthly = await request(app.getHttpServer())
      .get('/orders/monthly-summary')
      .query({ accountingMonth })
      .expect(200);
    expect(monthly.body).toMatchObject({
      accountingMonth,
      taskCount: 2,
      orderCount: 1,
      settledOrderCount: 1,
      settlementRecordCount: 2,
      settlementAmount: '10.00',
    });
    expect(monthly.body.orderBatchIds).toEqual([orderBatchId]);
    expect(monthly.body.settlementBatchIds).toEqual(expect.arrayContaining([settlementBatchId, secondSettlementBatchId]));

    const months = await request(app.getHttpServer()).get('/orders/summary-months').expect(200);
    expect(months.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountingMonth, completedTaskCount: expect.any(Number) }),
    ]));

    await request(app.getHttpServer()).post(`/reconciliation-tasks/${secondTask.body.id}/archive`).expect(201);
    const archivedSummary = await request(app.getHttpServer())
      .get('/orders/monthly-summary')
      .query({ accountingMonth })
      .expect(200);
    expect(archivedSummary.body).toMatchObject({
      taskCount: 1,
      orderCount: 1,
      settlementRecordCount: 1,
      settlementAmount: '7.00',
    });
  });

  it('按异常类型和关键词导出异常清单，并保留来源信息', async () => {
    const suffix = Date.now();
    const mainOrderNo = `9${suffix}`;
    const csv = [
      '主订单编号,子订单编号,选购商品,商家编码,商品数量,商品金额',
      `${mainOrderNo},${mainOrderNo},导出测试商品,EXPORT-SKU-${suffix},1,10`,
    ].join('\n');
    const upload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), `export-issues-${suffix}.csv`)
      .expect(201);
    const batchId = upload.body.batch.id as string;
    await request(app.getHttpServer()).post(`/orders/standardize/${batchId}`).expect(201);

    const issues = await request(app.getHttpServer()).get('/orders/issues').query({ orderBatchId: batchId }).expect(200);
    const missingCost = issues.body.find((issue: { issueType: string }) => issue.issueType === 'PRODUCT_ID_MISSING');
    expect(missingCost).toBeDefined();
    const response = await request(app.getHttpServer())
      .get('/orders/issues/export')
      .query({ orderBatchId: batchId, issueType: 'PRODUCT_ID_MISSING', query: mainOrderNo })
      .expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    const body = Buffer.isBuffer(response.body)
      ? response.body.toString('utf8')
      : String(response.text ?? response.body);
    expect(body).toContain('异常类型');
    expect(body).toContain('来源批次');
    expect(body).toContain(batchId);
    expect(body).toContain(mainOrderNo);
    expect(body).toContain('商品 ID 缺失');
    expect(body).toContain('待处理');
    expect(response.headers['content-disposition']).toContain('filename*=UTF-8');
    expect(decodeURIComponent(response.headers['content-disposition'])).toContain('异常清单_PRODUCT_ID_MISSING_');
  });
});
