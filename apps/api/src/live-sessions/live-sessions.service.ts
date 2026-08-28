import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LiveMatchStatus,
  OrderIssueType,
  OrderOwnershipType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma.service';

type RawLiveSession = Record<string, string>;

const SELF_INFLUENCER_IDS = new Set(['', '0', '108314295234']);

function pick(raw: RawLiveSession, key: string): string | undefined {
  const value = raw[key]?.trim();
  return value || undefined;
}

function parseChinaDateTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\//g, '-').replace(' ', 'T');
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}+08:00`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizeInfluencerId(value: string | null): string {
  return (value ?? '').replace(/[\s']/g, '').replace(/\.0$/, '');
}

function formatChinaCompact(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}${part('hour')}${part('minute')}${part('second')}`;
}

@Injectable()
export class LiveSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async standardizeBatch(batchId: string, orderBatchId?: string) {
    if (!orderBatchId) {
      throw new BadRequestException('请选择需要匹配的订单批次');
    }

    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rawRecords: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('导入批次不存在');
    if (batch.dataType !== 'DOUYIN_LIVE') {
      throw new BadRequestException('该批次不是直播明细数据');
    }
    if (batch.rawRecords.length === 0) {
      throw new BadRequestException('该批次没有可标准化的原始记录');
    }

    const orderBatch = await this.prisma.importBatch.findUnique({
      where: { id: orderBatchId },
    });
    if (!orderBatch || orderBatch.dataType !== 'DOUYIN_ORDER') {
      throw new BadRequestException('订单批次不存在或类型不正确');
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.shopOrder.updateMany({
        where: { batchId: orderBatchId },
        data: {
          ownershipType: null,
          liveMatchStatus: null,
          liveSessionId: null,
        },
      });
      await transaction.orderIssue.deleteMany({
        where: {
          orderId: {
            in: (
              await transaction.shopOrder.findMany({
                where: { batchId: orderBatchId },
                select: { id: true },
              })
            ).map((order) => order.id),
          },
          issueType: {
            in: [
              OrderIssueType.LIVE_SESSION_CONFLICT,
              OrderIssueType.ORDER_TIME_MISSING,
            ],
          },
        },
      });
      await transaction.liveSession.deleteMany({ where: { batchId } });

      const sessions = [];
      for (const record of batch.rawRecords) {
        const raw = record.rawData as RawLiveSession;
        const anchorDouyinId = pick(raw, '主播抖音号');
        const startedAt = parseChinaDateTime(pick(raw, '直播开始时间'));
        const endedAt = parseChinaDateTime(pick(raw, '直播结束时间'));
        if (!anchorDouyinId || !startedAt || !endedAt || endedAt < startedAt) {
          throw new BadRequestException(
            `直播明细第 ${record.rowNumber} 行的抖音号或直播时间无效`,
          );
        }
        const duration = pick(raw, '直播时长(分钟)');
        const session = await transaction.liveSession.create({
          data: {
            liveId: `DY-${anchorDouyinId}-${formatChinaCompact(startedAt)}`,
            anchorNickname: pick(raw, '主播昵称'),
            anchorDouyinId,
            startedAt,
            endedAt,
            durationMinutes:
              duration && /^\d+(\.\d+)?$/.test(duration) ? duration : null,
            batchId,
            rowNumber: record.rowNumber,
            sourceFileName: batch.sourceFileName,
            rawData: record.rawData as Prisma.InputJsonValue,
          },
        });
        sessions.push(session);
      }

      const orders = await transaction.shopOrder.findMany({
        where: { batchId: orderBatchId },
      });
      let selfLiveCount = 0;
      let selfNonLiveCount = 0;
      let influencerCount = 0;
      let conflictCount = 0;
      let missingTimeCount = 0;

      for (const order of orders) {
        const influencerId = normalizeInfluencerId(order.influencerId);
        const isSelf = SELF_INFLUENCER_IDS.has(influencerId);
        if (!isSelf) {
          influencerCount += 1;
          await transaction.shopOrder.update({
            where: { id: order.id },
            data: {
              ownershipType: OrderOwnershipType.INFLUENCER,
              liveMatchStatus: LiveMatchStatus.INFLUENCER,
            },
          });
          continue;
        }

        if (!order.submittedAt) {
          missingTimeCount += 1;
          await transaction.shopOrder.update({
            where: { id: order.id },
            data: {
              ownershipType: OrderOwnershipType.SELF,
              liveMatchStatus: LiveMatchStatus.MISSING_ORDER_TIME,
            },
          });
          await transaction.orderIssue.create({
            data: {
              issueType: OrderIssueType.ORDER_TIME_MISSING,
              mainOrderNo: order.mainOrderNo,
              orderId: order.id,
              message: `订单缺少提交时间，无法判断直播归属（订单号：${order.mainOrderNo}）`,
              detail: { liveBatchId: batchId },
              batchId,
              rowNumber: order.rowNumber,
              sourceFileName: order.sourceFileName,
            },
          });
          continue;
        }

        const matched = sessions.filter(
          (session) =>
            session.startedAt <= order.submittedAt! &&
            order.submittedAt! <= session.endedAt,
        );
        if (matched.length === 1) {
          selfLiveCount += 1;
          await transaction.shopOrder.update({
            where: { id: order.id },
            data: {
              ownershipType: OrderOwnershipType.SELF,
              liveMatchStatus: LiveMatchStatus.SELF_LIVE,
              liveSessionId: matched[0].id,
            },
          });
        } else if (matched.length === 0) {
          selfNonLiveCount += 1;
          await transaction.shopOrder.update({
            where: { id: order.id },
            data: {
              ownershipType: OrderOwnershipType.SELF,
              liveMatchStatus: LiveMatchStatus.SELF_NON_LIVE,
            },
          });
        } else {
          conflictCount += 1;
          await transaction.shopOrder.update({
            where: { id: order.id },
            data: {
              ownershipType: OrderOwnershipType.SELF,
              liveMatchStatus: LiveMatchStatus.CONFLICT,
            },
          });
          await transaction.orderIssue.create({
            data: {
              issueType: OrderIssueType.LIVE_SESSION_CONFLICT,
              mainOrderNo: order.mainOrderNo,
              orderId: order.id,
              message: `订单同时匹配 ${matched.length} 场直播，无法自动确定归属`,
              detail: { liveIds: matched.map((session) => session.liveId) },
              batchId,
              rowNumber: order.rowNumber,
              sourceFileName: order.sourceFileName,
            },
          });
        }
      }

      return {
        batchId,
        orderBatchId,
        liveSessionCount: sessions.length,
        selfLiveCount,
        selfNonLiveCount,
        influencerCount,
        conflictCount,
        missingTimeCount,
      };
    });
  }
}
