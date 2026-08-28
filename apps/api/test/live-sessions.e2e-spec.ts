import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('抖音直播归属', () => {
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

  it('自营订单提交时间落在一场直播内时归为自营上播', async () => {
    const suffix = Date.now();
    const mainOrderNo = `LIVE-SELF-${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,订单提交时间,达人ID',
      `${mainOrderNo},${mainOrderNo},2026-07-22 11:30:00,108314295234`,
    ].join('\n');

    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), `直播订单-${suffix}.csv`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/orders/standardize/${orderUpload.body.batch.id}`)
      .expect(201);

    const liveCsv = [
      '主播昵称,主播抖音号,直播开始时间,直播结束时间,直播时长(分钟)',
      '小象汉字图书旗舰店,xiaoxianghanzi,2026/07/22 11:00:21,2026/07/22 12:00:21,60',
    ].join('\n');

    const liveUpload = await request(app.getHttpServer())
      .post('/imports/live-sessions')
      .attach('file', Buffer.from(liveCsv, 'utf8'), `直播明细-${suffix}.csv`)
      .expect(201);

    expect(liveUpload.body.batch).toMatchObject({
      dataType: 'DOUYIN_LIVE',
      totalRows: 1,
      successRows: 1,
    });

    const standardizeResponse = await request(app.getHttpServer())
      .post(`/live-sessions/standardize/${liveUpload.body.batch.id}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);

    expect(standardizeResponse.body).toMatchObject({
      liveSessionCount: 1,
      selfLiveCount: 1,
      selfNonLiveCount: 0,
      influencerCount: 0,
      conflictCount: 0,
      missingTimeCount: 0,
    });

    const orderResponse = await request(app.getHttpServer())
      .get(`/orders/${mainOrderNo}`)
      .expect(200);

    expect(orderResponse.body).toMatchObject({
      ownershipType: 'SELF',
      liveMatchStatus: 'SELF_LIVE',
      liveSession: {
        liveId: 'DY-xiaoxianghanzi-20260722110021',
        anchorNickname: '小象汉字图书旗舰店',
        anchorDouyinId: 'xiaoxianghanzi',
      },
    });
  });

  it('能区分自营非上播、达人订单、直播冲突和订单时间缺失', async () => {
    const suffix = Date.now();
    const selfNonLiveOrder = `LIVE-NON-${suffix}`;
    const influencerOrder = `LIVE-INFLUENCER-${suffix}`;
    const conflictOrder = `LIVE-CONFLICT-${suffix}`;
    const missingTimeOrder = `LIVE-MISSING-${suffix}`;
    const orderCsv = [
      '主订单编号,子订单编号,订单提交时间,达人ID',
      `${selfNonLiveOrder},${selfNonLiveOrder},2026-07-22 13:00:00,0`,
      `${influencerOrder},${influencerOrder},2026-07-22 11:30:00,987654`,
      `${conflictOrder},${conflictOrder},2026-07-22 11:30:00,108314295234`,
      `${missingTimeOrder},${missingTimeOrder},,108314295234`,
    ].join('\n');

    const orderUpload = await request(app.getHttpServer())
      .post('/imports/orders')
      .attach('file', Buffer.from(orderCsv, 'utf8'), `直播边界订单-${suffix}.csv`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/orders/standardize/${orderUpload.body.batch.id}`)
      .expect(201);

    const liveCsv = [
      '主播昵称,主播抖音号,直播开始时间,直播结束时间,直播时长(分钟)',
      '小象汉字图书旗舰店,xiaoxianghanzi,2026-07-22 11:00:00,2026-07-22 12:00:00,60',
      '小象汉字图书旗舰店,xiaoxianghanzi,2026-07-22 11:20:00,2026-07-22 12:20:00,60',
    ].join('\n');
    const liveUpload = await request(app.getHttpServer())
      .post('/imports/live-sessions')
      .attach('file', Buffer.from(liveCsv, 'utf8'), `直播边界场次-${suffix}.csv`)
      .expect(201);

    const standardizeResponse = await request(app.getHttpServer())
      .post(`/live-sessions/standardize/${liveUpload.body.batch.id}`)
      .query({ orderBatchId: orderUpload.body.batch.id })
      .expect(201);

    expect(standardizeResponse.body).toMatchObject({
      liveSessionCount: 2,
      selfLiveCount: 0,
      selfNonLiveCount: 1,
      influencerCount: 1,
      conflictCount: 1,
      missingTimeCount: 1,
    });

    const [selfNonLive, influencer, conflict, missingTime] = await Promise.all(
      [selfNonLiveOrder, influencerOrder, conflictOrder, missingTimeOrder].map(
        (orderNo) =>
          request(app.getHttpServer())
            .get(`/orders/${orderNo}`)
            .expect(200)
            .then((response) => response.body),
      ),
    );
    expect(selfNonLive).toMatchObject({
      ownershipType: 'SELF',
      liveMatchStatus: 'SELF_NON_LIVE',
      liveSession: null,
    });
    expect(influencer).toMatchObject({
      ownershipType: 'INFLUENCER',
      liveMatchStatus: 'INFLUENCER',
      liveSession: null,
    });
    expect(conflict).toMatchObject({
      ownershipType: 'SELF',
      liveMatchStatus: 'CONFLICT',
      liveSession: null,
    });
    expect(missingTime).toMatchObject({
      ownershipType: 'SELF',
      liveMatchStatus: 'MISSING_ORDER_TIME',
      liveSession: null,
    });

    const issues = await request(app.getHttpServer())
      .get(`/orders/issues?orderBatchId=${orderUpload.body.batch.id}`)
      .expect(200);
    expect(issues.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueType: 'LIVE_SESSION_CONFLICT',
          mainOrderNo: conflictOrder,
        }),
        expect.objectContaining({
          issueType: 'ORDER_TIME_MISSING',
          mainOrderNo: missingTimeOrder,
        }),
      ]),
    );
  });
});
