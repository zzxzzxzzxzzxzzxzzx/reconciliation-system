import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('结算导入与关联', () => {
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

  it('导入结算文件、标准化并关联订单，支持一单多结算和退款负数', async () => {
    const mainOrderNo = `88${Date.now()}`;
    const orderWithoutSettlementNo = `87${Date.now()}`;
    const unmatchedNo = `99${Date.now()}`;

    const orderCsv = [
      '主订单编号,子订单编号,选购商品,商品ID,商家编码,商品数量,商品金额,订单状态',
      `${mainOrderNo},${mainOrderNo},测试商品-(T01),9001,T01,1,100.00,已完成`,
      `${orderWithoutSettlementNo},${orderWithoutSettlementNo},未结算商品-(T02),9002,T02,1,80.00,已完成`,
    ].join('\n');
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), 'link-orders.csv')
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${orderUpload.body.batch.id}`)
      .expect(201);

    const settlementCsv = [
      '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型,有结算前退款,下单时间,收入合计,支出合计,平台服务费,达人佣金',
      ' , , ,收入+支出, , , , , , , , ',
      `2026-07-01 05:59:20,'${mainOrderNo},'${mainOrderNo},97.02,聚合账户,已结算,否,2026-06-24 10:51:58,109.00,11.98,5.45,6.53`,
      `2026-07-20 18:34:00,'${mainOrderNo},'${mainOrderNo},-8,聚合账户,结算后退款-非原路退回,否,2026-06-24 10:51:58,0,8,0,0`,
      `2026-07-05 12:00:00,'${unmatchedNo},'${unmatchedNo},50.00,聚合账户,已结算,否,2026-06-30 09:00:00,55.00,5.00,2.75,0`,
    ].join('\n');

    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from(settlementCsv, 'utf8'), 'settlements.csv')
      .expect(201);

    expect(settlementUpload.body.batch).toMatchObject({
      dataType: 'DOUYIN_SETTLEMENT',
      status: 'COMPLETED',
      totalRows: 3,
      successRows: 3,
      failedRows: 0,
    });

    const settlementBatchId = settlementUpload.body.batch.id;
    const recordsResponse = await request(app.getHttpServer())
      .get(`/imports/${settlementBatchId}/records`)
      .expect(200);
    const dataRecord = recordsResponse.body.items.find(
      (item: { rowNumber: number }) => item.rowNumber === 3,
    );
    expect(dataRecord.rawData['订单号修复']).toBe(mainOrderNo);
    expect(dataRecord.rawData['订单号']).toBe(`'${mainOrderNo}`);

    const standardizeResponse = await request(app.getHttpServer())
      .post(`/settlements/standardize/${settlementBatchId}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);

    expect(standardizeResponse.body).toMatchObject({
      batchId: settlementBatchId,
      settlementCount: 3,
      matchedCount: 2,
      unmatchedCount: 1,
      ordersWithoutSettlementCount: 1,
      crossPeriodCount: 3,
    });

    await request(app.getHttpServer())
      .post(`/orders/standardize/${orderUpload.body.batch.id}`)
      .expect(201);

    const orderResponse = await request(app.getHttpServer())
      .get(`/orders/${mainOrderNo}`)
      .expect(200);
    expect(orderResponse.body.settlements).toHaveLength(2);
    // 97.02 + (-8) = 89.02
    expect(Number(orderResponse.body.settledAmount)).toBeCloseTo(89.02, 2);
    const refund = orderResponse.body.settlements.find(
      (item: { settlementType?: string }) =>
        item.settlementType === '结算后退款-非原路退回',
    );
    expect(Number(refund.amount)).toBe(-8);

    const byOrderResponse = await request(app.getHttpServer())
      .get(`/settlements/by-order/${mainOrderNo}`)
      .expect(200);
    expect(byOrderResponse.body.items).toHaveLength(2);
    expect(Number(byOrderResponse.body.totalAmount)).toBeCloseTo(89.02, 2);

    const issuesResponse = await request(app.getHttpServer())
      .get('/orders/issues')
      .expect(200);
    const unmatchedIssues = issuesResponse.body.filter(
      (issue: { issueType: string; mainOrderNo?: string }) =>
        issue.issueType === 'SETTLEMENT_WITHOUT_ORDER' &&
        issue.mainOrderNo === unmatchedNo,
    );
    expect(unmatchedIssues).toHaveLength(1);

    const orderWithoutSettlementIssues = issuesResponse.body.filter(
      (issue: { issueType: string; mainOrderNo?: string }) =>
        issue.issueType === 'ORDER_WITHOUT_SETTLEMENT' &&
        issue.mainOrderNo === orderWithoutSettlementNo,
    );
    expect(orderWithoutSettlementIssues).toHaveLength(1);

    const crossPeriodIssues = issuesResponse.body.filter(
      (issue: { issueType: string; mainOrderNo?: string }) =>
        issue.issueType === 'CROSS_PERIOD_SETTLEMENT' &&
        issue.mainOrderNo === mainOrderNo,
    );
    expect(crossPeriodIssues).toHaveLength(2);
    const unmatchedCrossPeriodIssues = issuesResponse.body.filter(
      (issue: { issueType: string; mainOrderNo?: string }) =>
        issue.issueType === 'CROSS_PERIOD_SETTLEMENT' &&
        issue.mainOrderNo === unmatchedNo,
    );
    expect(unmatchedCrossPeriodIssues).toHaveLength(1);

    const crossPeriodIssue = crossPeriodIssues[0] as { id: string };
    await request(app.getHttpServer())
      .patch(`/orders/issues/${crossPeriodIssue.id}`)
      .send({ status: 'CONFIRMED', note: '已确认跨期结算，按结算月份归属。' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.resolutionStatus).toBe('CONFIRMED');
        expect(body.resolutionNote).toBe('已确认跨期结算，按结算月份归属。');
      });
    const confirmedIssues = await request(app.getHttpServer())
      .get('/orders/issues')
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(200);
    expect(confirmedIssues.body.find((issue: { id: string }) => issue.id === crossPeriodIssue.id)).toMatchObject({
      resolutionStatus: 'CONFIRMED',
      resolutionNote: '已确认跨期结算，按结算月份归属。',
    });
    const unchangedOrderResponse = await request(app.getHttpServer())
      .get(`/orders/${mainOrderNo}`)
      .expect(200);
    expect(Number(unchangedOrderResponse.body.settledAmount)).toBeCloseTo(89.02, 2);

    const repeatResponse = await request(app.getHttpServer())
      .post(`/settlements/standardize/${settlementBatchId}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);
    expect(repeatResponse.body).toMatchObject({
      settlementCount: 3,
      matchedCount: 2,
      unmatchedCount: 1,
      ordersWithoutSettlementCount: 1,
      crossPeriodCount: 3,
    });
  });

  it('订单文件批次不能走结算标准化', async () => {
    const orderCsv = ['主订单编号,子订单编号', '1,1'].join('\n');
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), 'wrong-type.csv')
      .expect(201);
    await request(app.getHttpServer())
      .post(`/settlements/standardize/${orderUpload.body.batch.id}`)
      .expect(400);
  });
});
