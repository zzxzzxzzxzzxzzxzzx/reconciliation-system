import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('商品成本导入与历史快照', () => {
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

  it('成本版本导入后直接使用，新版本不覆盖历史订单成本快照', async () => {
    const suffix = Date.now().toString();
    const uniqueProductId = `COST-UNIQUE-${suffix}`;
    const conflictProductId = `COST-CONFLICT-${suffix}`;
    const missingProductId = `COST-MISSING-${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `COST-ORDER-1-${suffix},COST-SUB-1-${suffix},${uniqueProductId},SKU-1,商品一,2,30.00,2026-07-01 10:00:00`,
      `COST-ORDER-2-${suffix},COST-SUB-2-${suffix},${conflictProductId},SKU-2,商品二,1,30.00,2026-07-01 10:00:00`,
      `COST-ORDER-3-${suffix},COST-SUB-3-${suffix},${missingProductId},SKU-3,商品三,1,30.00,2026-07-01 10:00:00`,
    ].join('\n');
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), `cost-orders-${suffix}.csv`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${orderUpload.body.batch.id}`)
      .expect(201);

    const settlementCsv = [
      '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
      `2026-07-05 12:00:00,'COST-ORDER-1-${suffix},'COST-SUB-1-${suffix},50.00,聚合账户,已结算`,
    ].join('\n');
    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach(
        'file',
        Buffer.from(settlementCsv, 'utf8'),
        `cost-settlements-${suffix}.csv`,
      )
      .expect(201);
    await request(app.getHttpServer())
      .post(`/settlements/standardize/${settlementUpload.body.batch.id}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);

    const costCsv = [
      '商品ID,商品名称,商品数量,商品id 和 编码集合,成本,备注,商品id修复,单选',
      `'${uniqueProductId},商品一,1,'${uniqueProductId}SKU-1,12.50,, '${uniqueProductId},`,
      `'${conflictProductId},商品二,1,'${conflictProductId}SKU-2,20.00,, '${conflictProductId},`,
      `'${conflictProductId},商品二,1,'${conflictProductId}SKU-2,21.00,, '${conflictProductId},`,
      'RAW-ONLY,成本表说明,1,RAW-ONLY-SKU,,说明行,,',
    ].join('\n');
    const costUpload = await request(app.getHttpServer())
      .post('/imports/costs')
      .attach('file', Buffer.from(costCsv, 'utf8'), `成本表-${suffix}.csv`)
      .expect(201);

    expect(costUpload.body.batch).toMatchObject({
      dataType: 'DOUYIN_COST',
      status: 'COMPLETED_WITH_ERRORS',
      sourceFileName: expect.stringContaining('成本表'),
      totalRows: 4,
      successRows: 3,
      failedRows: 1,
    });

    const standardizeResponse = await request(app.getHttpServer())
      .post(`/costs/standardize/${costUpload.body.batch.id}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);

    expect(standardizeResponse.body).toMatchObject({
      costRowCount: 3,
      eligibleItemCount: 3,
      preservedItemCount: 0,
      matchedItemCount: 1,
      missingCostCount: 1,
      conflictCostCount: 1,
      versionStatus: 'ACTIVE',
    });
    const originalCostVersionId = standardizeResponse.body.costVersionId;

    const orderResponse = await request(app.getHttpServer())
      .get(`/orders/COST-ORDER-1-${suffix}`)
      .expect(200);
    expect(orderResponse.body.costSummary).toMatchObject({
      status: 'MATCHED',
      totalCost: '25.00',
      profit: '25.00',
    });
    expect(orderResponse.body.items[0].costSnapshot).toMatchObject({
      status: 'MATCHED',
      versionId: originalCostVersionId,
      unitCost: '12.50',
      totalCost: '25.00',
    });

    const newCostCsv = [
      '商品ID,商品名称,商品数量,商品id 和 编码集合,成本,备注,商品id修复,单选',
      `'${uniqueProductId},商品一,1,'${uniqueProductId}SKU-1,99.00,, '${uniqueProductId},`,
      `'${missingProductId},商品三,1,'${missingProductId}SKU-3,7.00,, '${missingProductId},`,
    ].join('\n');
    const newCostUpload = await request(app.getHttpServer())
      .post('/imports/costs')
      .attach(
        'file',
        Buffer.from(newCostCsv, 'utf8'),
        `新成本表-${suffix}.csv`,
      )
      .expect(201);
    const newStandardizeResponse = await request(app.getHttpServer())
      .post(`/costs/standardize/${newCostUpload.body.batch.id}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);
    expect(newStandardizeResponse.body).toMatchObject({
      costRowCount: 2,
      eligibleItemCount: 2,
      preservedItemCount: 1,
      matchedItemCount: 1,
      missingCostCount: 1,
      conflictCostCount: 0,
      versionStatus: 'ACTIVE',
    });

    const historicalOrderResponse = await request(app.getHttpServer())
      .get(`/orders/COST-ORDER-1-${suffix}`)
      .expect(200);
    expect(historicalOrderResponse.body.items[0].costSnapshot).toMatchObject({
      status: 'MATCHED',
      versionId: originalCostVersionId,
      unitCost: '12.50',
      totalCost: '25.00',
    });
    expect(historicalOrderResponse.body.costSummary.profit).toBe('25.00');

    const repairedOrderResponse = await request(app.getHttpServer())
      .get(`/orders/COST-ORDER-3-${suffix}`)
      .expect(200);
    expect(repairedOrderResponse.body.items[0].costSnapshot).toMatchObject({
      status: 'MATCHED',
      versionId: newStandardizeResponse.body.costVersionId,
      unitCost: '7.00',
      totalCost: '7.00',
    });

    const issuesResponse = await request(app.getHttpServer())
      .get('/orders/issues')
      .expect(200);
    expect(
      issuesResponse.body.filter(
        (issue: { issueType: string; mainOrderNo?: string }) =>
          issue.issueType === 'COST_MISSING' &&
          issue.mainOrderNo === `COST-ORDER-2-${suffix}`,
      ),
    ).toHaveLength(1);
    expect(
      issuesResponse.body.filter(
        (issue: { issueType: string; mainOrderNo?: string }) =>
          issue.issueType === 'COST_MISSING' &&
          issue.mainOrderNo === `COST-ORDER-3-${suffix}`,
      ),
    ).toHaveLength(0);
  });

  it('人工新增商品成本会生成完整新版本，并且只修复未匹配订单', async () => {
    const suffix = Date.now().toString();
    const existingProductId = `MANUAL-EXISTING-${suffix}`;
    const addedProductId = `MANUAL-ADDED-${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `MANUAL-ORDER-1-${suffix},MANUAL-SUB-1-${suffix},${existingProductId},SKU-1,已有商品,2,30.00,2026-07-01 10:00:00`,
      `MANUAL-ORDER-2-${suffix},MANUAL-SUB-2-${suffix},${addedProductId},SKU-2,待补商品,3,30.00,2026-07-01 10:00:00`,
    ].join('\n');
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), `manual-orders-${suffix}.csv`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${orderUpload.body.batch.id}`)
      .expect(201);

    const baseCostCsv = [
      '商品ID,商品名称,商品数量,商品id 和 编码集合,成本,备注,商品id修复,单选',
      `'${existingProductId},已有商品,1,'${existingProductId}SKU-1,12.50,原成本,'${existingProductId},`,
    ].join('\n');
    const baseCostUpload = await request(app.getHttpServer())
      .post('/imports/costs')
      .attach('file', Buffer.from(baseCostCsv, 'utf8'), `人工维护基础成本-${suffix}.csv`)
      .expect(201);
    const baseStandardize = await request(app.getHttpServer())
      .post(`/costs/standardize/${baseCostUpload.body.batch.id}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);

    const changeResponse = await request(app.getHttpServer())
      .post(`/costs/versions/${baseStandardize.body.costVersionId}/changes`)
      .send({
        changeType: 'ADD',
        productId: addedProductId,
        merchantCode: 'SKU-2',
        productName: '待补商品',
        unitCost: '7.80',
        reason: '补充成本表中遗漏的商品',
      })
      .expect(201);

    expect(changeResponse.body).toMatchObject({
      changeType: 'ADD',
      baseVersionId: baseStandardize.body.costVersionId,
      costRowCount: 2,
      changedProduct: {
        productId: addedProductId,
        merchantCode: 'SKU-2',
        unitCost: '7.80',
      },
    });

    const versionsResponse = await request(app.getHttpServer())
      .get('/costs/versions')
      .expect(200);
    expect(versionsResponse.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: changeResponse.body.id,
          batchId: changeResponse.body.batchId,
          costRowCount: 2,
          sourceType: 'MANUAL',
        }),
      ]),
    );

    const itemsResponse = await request(app.getHttpServer())
      .get(`/costs/versions/${changeResponse.body.id}/items`)
      .expect(200);
    expect(itemsResponse.body.total).toBe(2);
    expect(itemsResponse.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: existingProductId, unitCost: '12.50' }),
        expect.objectContaining({ productId: addedProductId, unitCost: '7.80' }),
      ]),
    );

    const newStandardize = await request(app.getHttpServer())
      .post(`/costs/standardize/${changeResponse.body.batchId}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);
    expect(newStandardize.body).toMatchObject({
      costRowCount: 2,
      eligibleItemCount: 1,
      preservedItemCount: 1,
      matchedItemCount: 1,
    });

    const historicalOrder = await request(app.getHttpServer())
      .get(`/orders/MANUAL-ORDER-1-${suffix}`)
      .expect(200);
    expect(historicalOrder.body.items[0].costSnapshot).toMatchObject({
      versionId: baseStandardize.body.costVersionId,
      unitCost: '12.50',
      totalCost: '25.00',
    });

    const repairedOrder = await request(app.getHttpServer())
      .get(`/orders/MANUAL-ORDER-2-${suffix}`)
      .expect(200);
    expect(repairedOrder.body.items[0].costSnapshot).toMatchObject({
      versionId: changeResponse.body.id,
      unitCost: '7.80',
      totalCost: '23.40',
    });

    await request(app.getHttpServer())
      .post(`/imports/${changeResponse.body.batchId}/archive`)
      .expect(201);
    const visibleVersions = await request(app.getHttpServer())
      .get('/costs/versions')
      .expect(200);
    expect(
      visibleVersions.body.items.some(
        (version: { id: string }) => version.id === changeResponse.body.id,
      ),
    ).toBe(false);
  });

  it('人工更正成本必须填写适用日期，并保留旧版本和历史订单成本', async () => {
    const suffix = Date.now().toString();
    const productId = `MANUAL-CORRECT-${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `CORRECT-ORDER-${suffix},CORRECT-SUB-${suffix},${productId},SKU-C,待更正商品,2,30.00,2026-07-01 10:00:00`,
    ].join('\n');
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), `correct-orders-${suffix}.csv`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${orderUpload.body.batch.id}`)
      .expect(201);

    const baseCostCsv = [
      '商品ID,商品名称,商品数量,商品id 和 编码集合,成本,备注,商品id修复,单选',
      `'${productId},待更正商品,1,'${productId}SKU-C,5.00,原成本,'${productId},`,
    ].join('\n');
    const baseCostUpload = await request(app.getHttpServer())
      .post('/imports/costs')
      .attach('file', Buffer.from(baseCostCsv, 'utf8'), `待更正成本-${suffix}.csv`)
      .expect(201);
    const baseStandardize = await request(app.getHttpServer())
      .post(`/costs/standardize/${baseCostUpload.body.batch.id}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);

    const missingDateResponse = await request(app.getHttpServer())
      .post(`/costs/versions/${baseStandardize.body.costVersionId}/changes`)
      .send({
        changeType: 'CORRECT',
        productId,
        merchantCode: 'SKU-C',
        productName: '待更正商品',
        unitCost: '6.20',
        reason: '成本从八月开始调整',
      })
      .expect(400);
    expect(missingDateResponse.body.message).toContain('开始适用日期');

    const correction = await request(app.getHttpServer())
      .post(`/costs/versions/${baseStandardize.body.costVersionId}/changes`)
      .send({
        changeType: 'CORRECT',
        productId,
        merchantCode: 'SKU-C',
        productName: '待更正商品',
        unitCost: '6.20',
        reason: '成本从八月开始调整',
        effectiveFrom: '2026-08-01',
      })
      .expect(201);
    expect(correction.body).toMatchObject({
      changeType: 'CORRECT',
      baseVersionId: baseStandardize.body.costVersionId,
      costRowCount: 1,
      changedProduct: { productId, merchantCode: 'SKU-C', unitCost: '6.20' },
    });

    const [baseItems, correctedItems, historicalOrder] = await Promise.all([
      request(app.getHttpServer())
        .get(`/costs/versions/${baseStandardize.body.costVersionId}/items`)
        .expect(200),
      request(app.getHttpServer())
        .get(`/costs/versions/${correction.body.id}/items`)
        .expect(200),
      request(app.getHttpServer())
        .get(`/orders/CORRECT-ORDER-${suffix}`)
        .expect(200),
    ]);
    expect(baseItems.body.items[0].unitCost).toBe('5.00');
    expect(correctedItems.body.items[0].unitCost).toBe('6.20');
    expect(historicalOrder.body.items[0].costSnapshot).toMatchObject({
      versionId: baseStandardize.body.costVersionId,
      unitCost: '5.00',
      totalCost: '10.00',
    });

    const mixedPeriodOrderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `BEFORE-CORRECTION-${suffix},BEFORE-SUB-${suffix},${productId},SKU-C,变更前订单,1,30.00,2026-07-31 23:59:59`,
      `AFTER-CORRECTION-${suffix},AFTER-SUB-${suffix},${productId},SKU-C,变更后订单,1,30.00,2026-08-01 00:00:00`,
    ].join('\n');
    const mixedPeriodOrderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(mixedPeriodOrderCsv, 'utf8'), `mixed-period-orders-${suffix}.csv`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${mixedPeriodOrderUpload.body.batch.id}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/costs/standardize/${correction.body.batchId}`)
      .query({ orderBatchId: mixedPeriodOrderUpload.body.batch.id })
      .expect(201);

    const [beforeCorrectionOrder, afterCorrectionOrder] = await Promise.all([
      request(app.getHttpServer())
        .get(`/orders/BEFORE-CORRECTION-${suffix}`)
        .expect(200),
      request(app.getHttpServer())
        .get(`/orders/AFTER-CORRECTION-${suffix}`)
        .expect(200),
    ]);
    expect(beforeCorrectionOrder.body.items[0].costSnapshot).toMatchObject({
      versionId: baseStandardize.body.costVersionId,
      unitCost: '5.00',
    });
    expect(afterCorrectionOrder.body.items[0].costSnapshot).toMatchObject({
      versionId: correction.body.id,
      unitCost: '6.20',
    });
  });
});
