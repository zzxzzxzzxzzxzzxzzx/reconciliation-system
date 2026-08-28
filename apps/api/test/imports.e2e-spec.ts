import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import writeXlsxFile from 'write-excel-file/node';
import { AppModule } from '../src/app.module';

describe('订单文件导入', () => {
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

  it('可以上传 CSV 并按字符串保留订单号和原始记录', async () => {
    const orderNo = `6920152002630${Date.now().toString().slice(-6)}`;
    const csv = [
      '主订单编号,子订单编号,支付方式',
      `${orderNo},${orderNo},抖音月付`,
    ].join('\n');

    const uploadResponse = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), 'orders.csv')
      .expect(201);

    expect(uploadResponse.body).toMatchObject({
      duplicate: false,
      batch: {
        status: 'COMPLETED',
        sourceFileName: 'orders.csv',
        totalRows: 1,
        successRows: 1,
        failedRows: 0,
      },
    });

    const recordsResponse = await request(app.getHttpServer())
      .get(`/imports/${uploadResponse.body.batch.id}/records`)
      .expect(200);

    expect(recordsResponse.body.items).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        rawData: expect.objectContaining({
          主订单编号: orderNo,
        }),
      }),
    ]);

    const rawFileResponse = await request(app.getHttpServer())
      .get(`/imports/${uploadResponse.body.batch.id}/raw-file`)
      .expect(200);
    expect(rawFileResponse.headers['content-type']).toContain('text/csv');
    expect(rawFileResponse.text).toContain('主订单编号');
    expect(rawFileResponse.text).toContain(orderNo);
  });

  it('重复上传同一文件时返回原批次且不重复写入', async () => {
    const orderNo = `6944008435477${Date.now().toString().slice(-6)}`;
    const file = Buffer.from(
      ['主订单编号,子订单编号', `${orderNo},${orderNo}`].join('\n'),
      'utf8',
    );

    const firstResponse = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', file, 'same-orders.csv')
      .expect(201);

    const duplicateResponse = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', file, 'same-orders.csv')
      .expect(201);

    expect(duplicateResponse.body).toMatchObject({
      duplicate: true,
      batch: {
        id: firstResponse.body.batch.id,
        totalRows: 1,
      },
    });

    const recordsResponse = await request(app.getHttpServer())
      .get(`/imports/${firstResponse.body.batch.id}/records`)
      .expect(200);

    expect(recordsResponse.body.items).toHaveLength(1);
  });

  it('缺少主订单编号表头时拒绝导入并返回问题批次', async () => {
    const csv = ['子订单编号,支付方式', '10001,抖音支付'].join('\n');

    const response = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), 'missing-header.csv')
      .expect(422);

    expect(response.body).toMatchObject({
      message: '缺少必填字段：主订单编号',
      status: 'FAILED',
    });
    expect(response.body.batchId).toEqual(expect.any(String));

    const batchResponse = await request(app.getHttpServer())
      .get(`/imports/${response.body.batchId}`)
      .expect(200);

    expect(batchResponse.body).toMatchObject({
      status: 'FAILED',
      totalRows: 1,
      successRows: 0,
      failedRows: 1,
      errors: [
        expect.objectContaining({
          code: 'MISSING_REQUIRED_HEADER',
          message: '缺少必填字段：主订单编号',
        }),
      ],
    });
  });

  it('主订单编号为空的行进入错误清单且不计入成功数量', async () => {
    const validOrderNo = `6920153440517${Date.now().toString().slice(-6)}`;
    const csv = [
      '主订单编号,子订单编号,支付方式',
      `${validOrderNo},${validOrderNo},抖音月付`,
      ',10002,支付宝',
    ].join('\n');

    const response = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(csv, 'utf8'), 'orders-with-error.csv')
      .expect(201);

    expect(response.body).toMatchObject({
      duplicate: false,
      batch: {
        status: 'COMPLETED_WITH_ERRORS',
        totalRows: 2,
        successRows: 1,
        failedRows: 1,
      },
    });

    const batchResponse = await request(app.getHttpServer())
      .get(`/imports/${response.body.batch.id}`)
      .expect(200);

    expect(batchResponse.body.errors).toEqual([
      expect.objectContaining({
        rowNumber: 3,
        code: 'MISSING_REQUIRED_VALUE',
        message: '主订单编号不能为空',
      }),
    ]);
  });

  it('可以上传 XLSX 并保持长订单号不变', async () => {
    const orderNo = `6944023648001${Date.now().toString().slice(-6)}`;
    const workbook = await writeXlsxFile([
      [{ value: '主订单编号' }, { value: '支付方式' }],
      [{ value: orderNo }, { value: '抖音支付' }],
    ]).toBuffer();

    const response = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', workbook, 'orders.xlsx')
      .expect(201);

    const recordsResponse = await request(app.getHttpServer())
      .get(`/imports/${response.body.batch.id}/records`)
      .expect(200);

    expect(recordsResponse.body.items[0].rawData).toMatchObject({
      主订单编号: orderNo,
    });
  });

  it('不支持的文件格式每次都明确拒绝且不生成重复批次', async () => {
    const file = Buffer.from('主订单编号\n10001', 'utf8');

    await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', file, 'orders.txt')
      .expect(400);

    await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', file, 'orders.txt')
      .expect(400);
  });

  it('同一文件同时上传时只创建一个批次', async () => {
    const orderNo = `6944008241854${Date.now().toString().slice(-6)}`;
    const file = Buffer.from(`主订单编号\n${orderNo}`, 'utf8');

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/imports/orders')
        .attach('file', file, 'concurrent-orders.csv'),
      request(app.getHttpServer())
        .post('/imports/orders')
        .attach('file', file, 'concurrent-orders.csv'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.map((response) => response.body.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    expect(responses[0].body.batch.id).toBe(responses[1].body.batch.id);
  });

  it('归档批次后默认隐藏，并且可以恢复', async () => {
    const file = Buffer.from(`主订单编号\n${Date.now()}`, 'utf8');
    const upload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', file, `archive-orders-${Date.now()}.csv`)
      .expect(201);
    const batchId = upload.body.batch.id;

    await request(app.getHttpServer()).post(`/imports/${batchId}/archive`).expect(201);
    const hidden = await request(app.getHttpServer()).get('/imports?dataType=DOUYIN_ORDER').expect(200);
    expect(hidden.body.some((batch: { id: string }) => batch.id === batchId)).toBe(false);

    const archived = await request(app.getHttpServer()).get('/imports?dataType=DOUYIN_ORDER&includeArchived=true').expect(200);
    expect(archived.body.find((batch: { id: string; archivedAt: string | null }) => batch.id === batchId)?.archivedAt).toEqual(expect.any(String));

    await request(app.getHttpServer()).post(`/imports/${batchId}/restore`).expect(201);
    const restored = await request(app.getHttpServer()).get('/imports?dataType=DOUYIN_ORDER').expect(200);
    expect(restored.body.some((batch: { id: string }) => batch.id === batchId)).toBe(true);
  });

  it('可以批量归档并恢复多个批次', async () => {
    const suffix = Date.now();
    const uploads = await Promise.all([1, 2].map((index) => request(app.getHttpServer())
      .post('/imports/orders')
      .attach(
        'file',
        Buffer.from(`主订单编号\n${suffix}${index}`, 'utf8'),
        `batch-archive-${suffix}-${index}.csv`,
      )
      .expect(201)));
    const batchIds = uploads.map((response) => response.body.batch.id as string);

    await request(app.getHttpServer())
      .post('/imports/batch/archive')
      .send({ batchIds })
      .expect(201)
      .expect(({ body }) => expect(body.count).toBe(2));

    const hidden = await request(app.getHttpServer())
      .get('/imports?dataType=DOUYIN_ORDER')
      .expect(200);
    expect(hidden.body.some((batch: { id: string }) => batchIds.includes(batch.id))).toBe(false);

    await request(app.getHttpServer())
      .post('/imports/batch/restore')
      .send({ batchIds })
      .expect(201)
      .expect(({ body }) => expect(body.count).toBe(2));

    const restored = await request(app.getHttpServer())
      .get('/imports?dataType=DOUYIN_ORDER')
      .expect(200);
    expect(batchIds.every((id) => restored.body.some((batch: { id: string }) => batch.id === id))).toBe(true);
  });

  it('批量归档没有选择批次时返回明确提示', async () => {
    await request(app.getHttpServer())
      .post('/imports/batch/archive')
      .send({ batchIds: [] })
      .expect(400)
      .expect(({ body }) => expect(body.message).toBe('请选择需要操作的导入批次'));
  });

  it('可以删除未被使用的误导入批次，并清理其原始记录', async () => {
    const file = Buffer.from(`主订单编号\n${Date.now()}`, 'utf8');
    const upload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', file, `delete-orders-${Date.now()}.csv`)
      .expect(201);
    const batchId = upload.body.batch.id as string;

    await request(app.getHttpServer())
      .delete(`/imports/${batchId}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ deleted: true, batchId }));

    await request(app.getHttpServer()).get(`/imports/${batchId}`).expect(404);
    await request(app.getHttpServer()).get(`/imports/${batchId}/records`).expect(404);
  });

  it('已被对账任务使用的批次不能删除，只能归档', async () => {
    const suffix = Date.now();
    const orderNo = `9${suffix}`;
    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(`主订单编号\n${orderNo}`, 'utf8'), `delete-used-orders-${suffix}.csv`)
      .expect(201);
    const settlementUpload = await request(app.getHttpServer())
      .post('/imports/settlements')
      .attach('file', Buffer.from(`订单号,结算时间\n${orderNo},2026-07-02 10:00:00`, 'utf8'), `delete-used-settlements-${suffix}.csv`)
      .expect(201);
    const task = await request(app.getHttpServer())
      .post('/reconciliation-tasks')
      .send({
        accountingMonth: '2026-07',
        orderBatchId: orderUpload.body.batch.id,
        settlementBatchId: settlementUpload.body.batch.id,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/imports/${orderUpload.body.batch.id}`)
      .expect(409)
      .expect(({ body }) => expect(body.message).toBe('该批次已被对账任务使用，只能归档，不能删除'));

    await request(app.getHttpServer()).get(`/reconciliation-tasks/${task.body.id}`).expect(200);
  });

  it('批量删除时只要包含不可删除批次就整体拒绝', async () => {
    const suffix = Date.now();
    const first = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(`主订单编号\n${suffix}1`, 'utf8'), `delete-batch-${suffix}-1.csv`)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(`主订单编号\n${suffix}2`, 'utf8'), `delete-batch-${suffix}-2.csv`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/orders/standardize/${second.body.batch.id}`)
      .expect(201);

    await request(app.getHttpServer())
      .delete('/imports/batch')
      .send({ batchIds: [first.body.batch.id, second.body.batch.id] })
      .expect(409);

    await request(app.getHttpServer()).get(`/imports/${first.body.batch.id}`).expect(200);
  });

  it('损坏的 XLSX 文件生成失败批次并返回可查询的解析错误', async () => {
    const response = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach(
        'file',
        Buffer.from(`not-an-xlsx-${Date.now()}`, 'utf8'),
        'broken.xlsx',
      )
      .expect(422);

    expect(response.body).toMatchObject({
      message: '订单文件内容无法解析',
      status: 'FAILED',
    });

    const batchResponse = await request(app.getHttpServer())
      .get(`/imports/${response.body.batchId}`)
      .expect(200);

    expect(batchResponse.body).toMatchObject({
      status: 'FAILED',
      errors: [
        expect.objectContaining({
          code: 'FILE_PARSE_ERROR',
          message: '订单文件内容无法解析',
        }),
      ],
    });
  });
});
