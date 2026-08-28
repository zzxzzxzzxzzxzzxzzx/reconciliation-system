import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderIssueType, Prisma } from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma.service';
import {
  RawSettlementData,
  SettlementNormalizer,
} from './settlement-normalizer';

function chinaYearMonth(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalizer: SettlementNormalizer,
  ) {}

  async standardizeBatch(batchId: string, orderBatchId?: string) {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rawRecords: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) {
      throw new NotFoundException('导入批次不存在');
    }
    if (batch.dataType !== 'DOUYIN_SETTLEMENT') {
      throw new BadRequestException('该批次不是结算数据');
    }
    if (batch.rawRecords.length === 0) {
      throw new BadRequestException('该批次没有可标准化的原始记录');
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.settlement.deleteMany({
        where: { batchId },
      });
      await transaction.orderIssue.deleteMany({
        where: {
          batchId,
          issueType: {
            in: [
              OrderIssueType.SETTLEMENT_WITHOUT_ORDER,
              OrderIssueType.ORDER_WITHOUT_SETTLEMENT,
              OrderIssueType.CROSS_PERIOD_SETTLEMENT,
            ],
          },
        },
      });

      const orders = await transaction.shopOrder.findMany({
        where: orderBatchId ? { batchId: orderBatchId } : undefined,
        select: { id: true, mainOrderNo: true, submittedAt: true },
      });
      const orderIdByNo = new Map(
        orders.map((order) => [order.mainOrderNo, order.id]),
      );

      let settlementCount = 0;
      let matchedCount = 0;
      let unmatchedCount = 0;
      let crossPeriodCount = 0;
      const matchedOrderIds = new Set<string>();

      for (const record of batch.rawRecords) {
        const rawData = record.rawData as RawSettlementData;
        // 跳过导入时标记的说明行：订单号修复为空即非数据行
        if (!rawData['订单号修复']?.trim()) {
          continue;
        }
        const normalized = this.normalizer.normalize(rawData);
        const orderId = orderIdByNo.get(normalized.orderNoFixed);

        await transaction.settlement.create({
          data: {
            orderNoFixed: normalized.orderNoFixed,
            subOrderNoFixed: normalized.subOrderNoFixed,
            settledAt: normalized.settledAt,
            amount: normalized.amount,
            account: normalized.account,
            settlementType: normalized.settlementType,
            hasRefundBefore: normalized.hasRefundBefore,
            orderedAt: normalized.orderedAt,
            productId: normalized.productId,
            productName: normalized.productName,
            productQuantity: normalized.productQuantity,
            influencerId: normalized.influencerId,
            influencerName: normalized.influencerName,
            businessType: normalized.businessType,
            orderType: normalized.orderType,
            orderTotalPrice: normalized.orderTotalPrice,
            productTotalPrice: normalized.productTotalPrice,
            shippingFee: normalized.shippingFee,
            incomeTotal: normalized.incomeTotal,
            expenseTotal: normalized.expenseTotal,
            platformServiceFee: normalized.platformServiceFee,
            influencerCommission: normalized.influencerCommission,
            merchantEntity: normalized.merchantEntity,
            appChannel: normalized.appChannel,
            remark: normalized.remark,
            orderId: orderId ?? null,
            batchId,
            rowNumber: record.rowNumber,
            sourceFileName: batch.sourceFileName,
            rawData: record.rawData as Prisma.InputJsonValue,
          },
        });
        settlementCount += 1;

        const order = orderId
          ? orders.find((item) => item.id === orderId)
          : undefined;
        const orderedAt = order?.submittedAt ?? normalized.orderedAt;
        if (
          orderedAt &&
          normalized.settledAt &&
          chinaYearMonth(orderedAt) !== chinaYearMonth(normalized.settledAt)
        ) {
          const orderMonth = chinaYearMonth(orderedAt);
          const settlementMonth = chinaYearMonth(normalized.settledAt);
          crossPeriodCount += 1;
          await transaction.orderIssue.create({
            data: {
              issueType: OrderIssueType.CROSS_PERIOD_SETTLEMENT,
              mainOrderNo: normalized.orderNoFixed,
              orderId: order?.id,
              message: `订单月份与结算月份不一致（订单：${orderMonth}，结算：${settlementMonth}）`,
              detail: {
                orderMonth,
                settlementMonth,
                settlementAmount: normalized.amount,
              },
              batchId,
              rowNumber: record.rowNumber,
              sourceFileName: batch.sourceFileName,
            },
          });
        }

        if (orderId) {
          matchedCount += 1;
          matchedOrderIds.add(orderId);
        } else {
          unmatchedCount += 1;
          await transaction.orderIssue.create({
            data: {
              issueType: OrderIssueType.SETTLEMENT_WITHOUT_ORDER,
              mainOrderNo: normalized.orderNoFixed,
              message: `结算记录未找到对应订单（订单号：${normalized.orderNoFixed}），可能为缺订单或跨期结算`,
              detail: {
                settlementAmount: normalized.amount,
                settlementType: normalized.settlementType,
                settledAt: normalized.settledAt?.toISOString(),
              },
              batchId,
              rowNumber: record.rowNumber,
              sourceFileName: batch.sourceFileName,
            },
          });
        }
      }

      const ordersWithoutSettlement = orders.filter(
        (order) => !matchedOrderIds.has(order.id),
      );
      if (ordersWithoutSettlement.length > 0) {
        const orderDetails = await transaction.shopOrder.findMany({
          where: { id: { in: ordersWithoutSettlement.map((order) => order.id) } },
          select: {
            id: true,
            mainOrderNo: true,
            batchId: true,
            rowNumber: true,
            sourceFileName: true,
          },
        });
        await transaction.orderIssue.createMany({
          data: orderDetails.map((order) => ({
            issueType: OrderIssueType.ORDER_WITHOUT_SETTLEMENT,
            mainOrderNo: order.mainOrderNo,
            orderId: order.id,
            message: `订单未找到本次导入结算记录（订单号：${order.mainOrderNo}），可能为未结算或跨期结算`,
            detail: {
              orderBatchId: order.batchId,
              settlementBatchId: batchId,
            },
            batchId,
            rowNumber: order.rowNumber,
            sourceFileName: order.sourceFileName,
          })),
        });
      }

      return {
        batchId,
        settlementCount,
        matchedCount,
        unmatchedCount,
        ordersWithoutSettlementCount: ordersWithoutSettlement.length,
        crossPeriodCount,
      };
    });
  }

  async getOrderSettlements(mainOrderNo: string) {
    const items = await this.prisma.settlement.findMany({
      where: { orderNoFixed: mainOrderNo },
      orderBy: [{ settledAt: 'asc' }, { rowNumber: 'asc' }],
    });
    const totalAmount = items.reduce(
      (sum, item) => sum.plus(item.amount),
      new Prisma.Decimal(0),
    );
    return { mainOrderNo, totalAmount: totalAmount.toFixed(2), items };
  }

  async listSettlements(page = 1, pageSize = 20) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.min(100, Math.max(1, pageSize));
    const [total, items] = await this.prisma.$transaction([
      this.prisma.settlement.count(),
      this.prisma.settlement.findMany({
        orderBy: [{ settledAt: 'desc' }, { id: 'asc' }],
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
      }),
    ]);
    return { total, page: safePage, pageSize: safePageSize, items };
  }
}
