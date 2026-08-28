import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OrderIssueType } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma.service';

describe('对账任务', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('可以绑定批次并运行对账任务', async () => {
    const suffix = Date.now();
    const orderNo = `9${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `${orderNo},${orderNo},TASK-PRODUCT-${suffix},TASK-SKU-${suffix},任务商品,1,30.00,2026-07-01 10:00:00`,
    ].join('\n');
    const orderUpload = await request(app.getHttpServer()).post('/imports/orders').attach('file', Buffer.from(orderCsv), `task-orders-${suffix}.csv`).expect(201);
    const orderBatchId = orderUpload.body.batch.id;

    const settlementCsv = [
      '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
      `2026-07-02 10:00:00,'${orderNo},'${orderNo},30.00,聚合账户,已结算`,
    ].join('\n');
    const settlementUpload = await request(app.getHttpServer()).post('/imports/settlements').attach('file', Buffer.from(settlementCsv), `task-settlements-${suffix}.csv`).expect(201);
    const settlementBatchId = settlementUpload.body.batch.id;

    const sourceIssue = await app.get(PrismaService).orderIssue.create({
      data: {
        issueType: OrderIssueType.COST_MISSING,
        mainOrderNo: orderNo,
        message: '测试补充任务来源',
        detail: { productId: `TASK-PRODUCT-${suffix}`, merchantCode: `TASK-SKU-${suffix}` },
        batchId: orderBatchId,
        rowNumber: 2,
        sourceFileName: `task-orders-${suffix}.csv`,
      },
    });

    await request(app.getHttpServer()).post('/reconciliation-tasks').send({
      accountingMonth: '2026-07',
      orderBatchId,
      settlementBatchId,
      sourceIssueId: sourceIssue.id,
      supplementTarget: 'DOUYIN_SETTLEMENT',
    }).expect(400, { statusCode: 400, message: '补充数据类型与来源异常不匹配', error: 'Bad Request' });

    const taskResponse = await request(app.getHttpServer()).post('/reconciliation-tasks').send({
      accountingMonth: '2026-07',
      orderBatchId,
      settlementBatchId,
      sourceIssueId: sourceIssue.id,
      supplementTarget: 'DOUYIN_COST',
    }).expect(201);
    expect(taskResponse.body).toMatchObject({
      accountingMonth: '2026-07',
      status: 'READY',
      sourceIssueType: 'COST_MISSING',
      sourceIssueOrderNo: orderNo,
      supplementTarget: 'DOUYIN_COST',
    });

    const linkedIssues = await request(app.getHttpServer())
      .get('/orders/issues')
      .query({ orderBatchId })
      .expect(200);
    expect(linkedIssues.body.find((issue: { id: string }) => issue.id === sourceIssue.id)).toMatchObject({
      resolutionStatus: 'PENDING',
      supplementTasks: [
        {
          id: taskResponse.body.id,
          status: 'READY',
          supplementTarget: 'DOUYIN_COST',
        },
      ],
    });

    const runResponse = await request(app.getHttpServer()).post(`/reconciliation-tasks/${taskResponse.body.id}/run`).expect(201);
    expect(runResponse.body.task).toMatchObject({ id: taskResponse.body.id, status: 'COMPLETED' });
    expect(runResponse.body.summary).toMatchObject({ orderCount: 1, settlementAmount: '30.00' });

    const linkedIssuesAfterRun = await request(app.getHttpServer())
      .get('/orders/issues')
      .query({ orderBatchId })
      .expect(200);
    expect(linkedIssuesAfterRun.body.find((issue: { id: string }) => issue.id === sourceIssue.id)).toMatchObject({
      resolutionStatus: 'PENDING',
      supplementTasks: [{ id: taskResponse.body.id, status: 'COMPLETED' }],
    });

    const laterSettlementCsv = [
      '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
      `2026-08-02 10:00:00,'${orderNo},'${orderNo},5.00,聚合账户,补充结算`,
    ].join('\n');
    const laterSettlementUpload = await request(app.getHttpServer()).post('/imports/settlements').attach('file', Buffer.from(laterSettlementCsv), `task-settlements-later-${suffix}.csv`).expect(201);
    await request(app.getHttpServer())
      .post(`/settlements/standardize/${laterSettlementUpload.body.batch.id}`)
      .query({ orderBatchId })
      .expect(201);

    const scopedSummary = await request(app.getHttpServer())
      .get('/orders/summary')
      .query({ orderBatchId, settlementBatchId })
      .expect(200);
    expect(scopedSummary.body.settlementAmount).toBe('30.00');

    const scopedOrders = await request(app.getHttpServer())
      .get('/orders')
      .query({ batchId: orderBatchId, settlementBatchId, pageSize: 20 })
      .expect(200);
    expect(scopedOrders.body.items[0].settledAmount).toBe('30.00');

    const listResponse = await request(app.getHttpServer()).get('/reconciliation-tasks').expect(200);
    expect(listResponse.body.some((task: { id: string }) => task.id === taskResponse.body.id)).toBe(true);
  });

  it('归档任务后默认隐藏，并且可以恢复', async () => {
    const tasks = await request(app.getHttpServer()).get('/reconciliation-tasks').expect(200);
    const task = tasks.body[0];
    expect(task?.id).toEqual(expect.any(String));

    await request(app.getHttpServer()).post(`/reconciliation-tasks/${task.id}/archive`).expect(201);
    const hidden = await request(app.getHttpServer()).get('/reconciliation-tasks').expect(200);
    expect(hidden.body.some((item: { id: string }) => item.id === task.id)).toBe(false);

    const archived = await request(app.getHttpServer()).get('/reconciliation-tasks?includeArchived=true').expect(200);
    expect(archived.body.find((item: { id: string; archivedAt: string | null }) => item.id === task.id)?.archivedAt).toEqual(expect.any(String));

    await request(app.getHttpServer()).post(`/reconciliation-tasks/${task.id}/restore`).expect(201);
    const restored = await request(app.getHttpServer()).get('/reconciliation-tasks').expect(200);
    expect(restored.body.some((item: { id: string }) => item.id === task.id)).toBe(true);
  });

  it('创建任务时完整重复订单文件自动复用已处理的原订单批次', async () => {
    const suffix = Date.now();
    const orderNo = `9${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `${orderNo},${orderNo},DUPLICATE-PRODUCT-${suffix},DUPLICATE-SKU-${suffix},重复订单商品,1,20.00,2026-07-10 10:00:00`,
    ].join('\n');
    const firstUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), `duplicate-orders-first-${suffix}.csv`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${firstUpload.body.batch.id}`)
      .expect(201);

    const duplicateOrderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `${orderNo},${orderNo},DUPLICATE-PRODUCT-${suffix},DUPLICATE-SKU-${suffix},重复订单商品（再次导出）,1,20.00,2026-07-10 10:00:00`,
    ].join('\n');
    const duplicateUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(duplicateOrderCsv, 'utf8'), `duplicate-orders-second-${suffix}.csv`)
      .expect(201);
    expect(duplicateUpload.body.batch.id).not.toBe(firstUpload.body.batch.id);
    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from([
        '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
        `2026-07-11 10:00:00,'${orderNo},'${orderNo},20.00,聚合账户,已结算`,
      ].join('\n'), 'utf8'), `duplicate-settlement-${suffix}.csv`)
      .expect(201);

    const taskResponse = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send({
        accountingMonth: '2026-07',
        orderBatchId: duplicateUpload.body.batch.id,
        settlementBatchId: settlementUpload.body.batch.id,
      })
      .expect(201);
    expect(taskResponse.body).toMatchObject({
      orderBatchId: firstUpload.body.batch.id,
      orderBatchReused: true,
      orderBatchReuseMessage: '检测到订单号全部已存在，已自动使用原订单批次',
    });

    const runResponse = await request(app.getHttpServer())
      .post(`/reconciliation-tasks/${taskResponse.body.id}/run`)
      .expect(201);
    expect(runResponse.body.task).toMatchObject({
      status: 'COMPLETED',
      orderBatchId: firstUpload.body.batch.id,
    });
  });

  it('创建任务时部分订单重复会阻止任务创建并说明重复数量', async () => {
    const suffix = Date.now();
    const existingOrderNo = `9${suffix}`;
    const firstUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from([
        '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
        `${existingOrderNo},${existingOrderNo},PARTIAL-EXISTING-${suffix},SKU-1,已有订单,1,20.00,2026-07-10 10:00:00`,
      ].join('\n'), 'utf8'), `partial-first-${suffix}.csv`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${firstUpload.body.batch.id}`)
      .expect(201);

    const mixedUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from([
        '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
        `${existingOrderNo},${existingOrderNo},PARTIAL-EXISTING-${suffix},SKU-1,已有订单,1,20.00,2026-07-10 10:00:00`,
        `9${suffix}1,9${suffix}1,PARTIAL-NEW-${suffix},SKU-2,新订单,1,30.00,2026-07-10 11:00:00`,
      ].join('\n'), 'utf8'), `partial-mixed-${suffix}.csv`)
      .expect(201);
    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from([
        '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
        `2026-07-11 10:00:00,'${existingOrderNo},'${existingOrderNo},20.00,聚合账户,已结算`,
      ].join('\n'), 'utf8'), `partial-settlement-${suffix}.csv`)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send({
        accountingMonth: '2026-07',
        orderBatchId: mixedUpload.body.batch.id,
        settlementBatchId: settlementUpload.body.batch.id,
      })
      .expect(409);
    expect(response.body.message).toContain('订单文件中有 1 个订单号已在其他批次处理过');
  });

  it('任务创建后原订单批次完成，启动任务时自动切换到原批次', async () => {
    const suffix = Date.now();
    const orderNo = `9${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `${orderNo},${orderNo},RETRY-PRODUCT-${suffix},RETRY-SKU-${suffix},重试订单商品,1,18.00,2026-07-12 10:00:00`,
    ].join('\n');
    const originalUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), `retry-orders-original-${suffix}.csv`)
      .expect(201);
    const retryOrderCsv = [
      '主订单编号,子订单编号,商品ID,商家编码,选购商品,商品数量,商品金额,订单提交时间',
      `${orderNo},${orderNo},RETRY-PRODUCT-${suffix},RETRY-SKU-${suffix},重试订单商品（再次导出）,1,18.00,2026-07-12 10:00:00`,
    ].join('\n');
    const retryUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(retryOrderCsv, 'utf8'), `retry-orders-task-${suffix}.csv`)
      .expect(201);
    expect(retryUpload.body.batch.id).not.toBe(originalUpload.body.batch.id);
    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from([
        '结算时间,订单号,子订单号,结算金额,结算账户,结算单类型',
        `2026-07-13 10:00:00,'${orderNo},'${orderNo},18.00,聚合账户,已结算`,
      ].join('\n'), 'utf8'), `retry-settlement-${suffix}.csv`)
      .expect(201);

    const taskResponse = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send({
        accountingMonth: '2026-07',
        orderBatchId: retryUpload.body.batch.id,
        settlementBatchId: settlementUpload.body.batch.id,
      })
      .expect(201);
    expect(taskResponse.body.orderBatchId).toBe(retryUpload.body.batch.id);

    await request(app.getHttpServer())
      .post(`/orders/standardize/${originalUpload.body.batch.id}`)
      .expect(201);

    const runResponse = await request(app.getHttpServer())
      .post(`/reconciliation-tasks/${taskResponse.body.id}/run`)
      .expect(201);
    expect(runResponse.body.task).toMatchObject({
      status: 'COMPLETED',
      orderBatchId: originalUpload.body.batch.id,
    });
  });

  it('相同月份和批次重复创建时返回原任务且不新增记录', async () => {
    const suffix = Date.now();
    const orderNo = `9${suffix}`;
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from([
        '主订单编号,子订单编号,商品ID,订单提交时间',
        `${orderNo},${orderNo},IDENTITY-${suffix},2026-09-01 10:00:00`,
      ].join('\n'), 'utf8'), `identity-orders-${suffix}.csv`)
      .expect(201);
    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from([
        '结算时间,订单号,子订单号,结算金额',
        `2026-09-02 10:00:00,'${orderNo},'${orderNo},12.00`,
      ].join('\n'), 'utf8'), `identity-settlement-${suffix}.csv`)
      .expect(201);
    const input = {
      accountingMonth: '2026-09',
      orderBatchId: orderUpload.body.batch.id,
      settlementBatchId: settlementUpload.body.batch.id,
    };

    const first = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send(input)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send(input)
      .expect(201);

    expect(second.body).toMatchObject({
      id: first.body.id,
      duplicate: true,
      duplicateMessage: '相同对账任务已存在，未重复创建',
    });
    expect(await app.get(PrismaService).reconciliationTask.count({ where: input })).toBe(1);

    await request(app.getHttpServer()).post(`/reconciliation-tasks/${first.body.id}/archive`).expect(201);
    const restored = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send(input)
      .expect(201);
    expect(restored.body).toMatchObject({ id: first.body.id, duplicate: true, archivedAt: null });
  });

  it('待运行任务可以删除且不会删除导入批次', async () => {
    const suffix = Date.now();
    const orderNo = `9${suffix}`;
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(`主订单编号\n${orderNo}`, 'utf8'), `delete-task-orders-${suffix}.csv`)
      .expect(201);
    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from(`订单号\n'${orderNo}`, 'utf8'), `delete-task-settlement-${suffix}.csv`)
      .expect(201);
    const task = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send({
        accountingMonth: '2026-10',
        orderBatchId: orderUpload.body.batch.id,
        settlementBatchId: settlementUpload.body.batch.id,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/reconciliation-tasks/${task.body.id}`)
      .expect(200, { deleted: true, taskId: task.body.id });
    await request(app.getHttpServer()).get(`/reconciliation-tasks/${task.body.id}`).expect(404);
    await request(app.getHttpServer()).get(`/imports/${orderUpload.body.batch.id}`).expect(200);
    await request(app.getHttpServer()).get(`/imports/${settlementUpload.body.batch.id}`).expect(200);
  });

  it('处理中任务和唯一已完成任务不能删除', async () => {
    const prisma = app.get(PrismaService);
    const baseTask = await prisma.reconciliationTask.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(baseTask).not.toBeNull();

    await request(app.getHttpServer())
      .delete(`/reconciliation-tasks/${baseTask!.id}`)
      .expect(409, {
        statusCode: 409,
        message: '已完成任务没有重复记录，只能归档',
        error: 'Conflict',
      });

    const processingTask = await prisma.reconciliationTask.create({
      data: {
        accountingMonth: '2026-11',
        status: 'PROCESSING',
        orderBatchId: baseTask!.orderBatchId,
        settlementBatchId: baseTask!.settlementBatchId,
      },
    });
    await request(app.getHttpServer())
      .delete(`/reconciliation-tasks/${processingTask.id}`)
      .expect(409, {
        statusCode: 409,
        message: '任务正在处理中，不能删除',
        error: 'Conflict',
      });
  });

  it('重复的已完成任务可以删除一条但必须保留另一条', async () => {
    const prisma = app.get(PrismaService);
    const original = await prisma.reconciliationTask.findFirstOrThrow({
      where: { status: 'COMPLETED', sourceIssueKey: null },
      orderBy: { createdAt: 'desc' },
    });
    const duplicate = await prisma.reconciliationTask.create({
      data: {
        accountingMonth: original.accountingMonth,
        status: 'COMPLETED',
        orderBatchId: original.orderBatchId,
        settlementBatchId: original.settlementBatchId,
        costBatchId: original.costBatchId,
        liveBatchId: original.liveBatchId,
        sourceIssueKey: original.sourceIssueKey,
        sourceIssueType: original.sourceIssueType,
        sourceIssueOrderNo: original.sourceIssueOrderNo,
        supplementTarget: original.supplementTarget,
      },
    });

    const tasks = await request(app.getHttpServer()).get('/reconciliation-tasks').expect(200);
    expect(tasks.body.find((task: { id: string }) => task.id === duplicate.id)).toMatchObject({
      canDelete: true,
      duplicateCount: 2,
    });
    await request(app.getHttpServer())
      .delete(`/reconciliation-tasks/${duplicate.id}`)
      .expect(200, { deleted: true, taskId: duplicate.id });
    await request(app.getHttpServer()).get(`/reconciliation-tasks/${original.id}`).expect(200);
    await request(app.getHttpServer())
      .delete(`/reconciliation-tasks/${original.id}`)
      .expect(409);
  });
});
