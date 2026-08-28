import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CostSnapshotStatus,
  IssueResolutionStatus,
  OrderIssueType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma.service';
import { OrderNormalizer, RawOrderData } from './order-normalizer';

type IssueForKey = {
  issueType: OrderIssueType;
  mainOrderNo: string | null;
  rowNumber: number | null;
  sourceFileName: string | null;
  detail: Prisma.JsonValue | null;
};

type ExportIssueParams = {
  orderBatchId?: string;
  issueType?: string;
  status?: IssueResolutionStatus;
  query?: string;
};

const issueExportLabels: Record<OrderIssueType, string> = {
  [OrderIssueType.SPLIT_AMBIGUOUS]: '商品拆分待确认',
  [OrderIssueType.PRODUCT_ID_MISSING]: '商品 ID 缺失',
  [OrderIssueType.PRODUCT_UNMATCHED]: '商品无法匹配',
  [OrderIssueType.COST_MISSING]: '缺成本',
  [OrderIssueType.COST_CONFLICT]: '成本冲突',
  [OrderIssueType.ORDER_WITHOUT_SETTLEMENT]: '未结算',
  [OrderIssueType.SETTLEMENT_WITHOUT_ORDER]: '缺订单',
  [OrderIssueType.CROSS_PERIOD_SETTLEMENT]: '跨期结算',
  [OrderIssueType.LIVE_SESSION_CONFLICT]: '直播冲突',
  [OrderIssueType.ORDER_TIME_MISSING]: '缺少下单时间',
};

const issueResolutionExportLabels: Record<IssueResolutionStatus, string> = {
  [IssueResolutionStatus.PENDING]: '待处理',
  [IssueResolutionStatus.NEEDS_DATA]: '待补订单数据',
  [IssueResolutionStatus.CONFIRMED]: '已确认',
  [IssueResolutionStatus.RESOLVED]: '已解决',
};

function issueResolutionKey(issue: IssueForKey) {
  const detail = issue.detail && typeof issue.detail === 'object' && !Array.isArray(issue.detail)
    ? issue.detail as Record<string, Prisma.JsonValue>
    : {};
  const productIdentity = issue.issueType === OrderIssueType.COST_MISSING
    || issue.issueType === OrderIssueType.COST_CONFLICT
    || issue.issueType === OrderIssueType.PRODUCT_ID_MISSING
    || issue.issueType === OrderIssueType.PRODUCT_UNMATCHED
    ? `${String(detail.productId ?? '')}|${String(detail.merchantCode ?? '')}`
    : '';
  return [
    issue.issueType,
    issue.mainOrderNo ?? '',
    issue.sourceFileName ?? '',
    issue.rowNumber ?? '',
    productIdentity,
  ].join('|');
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalizer: OrderNormalizer,
  ) {}

  async standardizeBatch(batchId: string) {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rawRecords: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) {
      throw new NotFoundException('导入批次不存在');
    }
    if (batch.dataType !== 'DOUYIN_ORDER') {
      throw new BadRequestException('该批次不是订单数据');
    }
    if (batch.rawRecords.length === 0) {
      throw new BadRequestException('该批次没有可标准化的原始记录');
    }

    const existingOrderCount = await this.prisma.shopOrder.count({
      where: { batchId },
    });
    if (existingOrderCount > 0) {
      const [itemCount, issueCount] = await this.prisma.$transaction([
        this.prisma.orderItem.count({ where: { batchId } }),
        this.prisma.orderIssue.count({
          where: { batchId, issueType: OrderIssueType.SPLIT_AMBIGUOUS },
        }),
      ]);
      return { batchId, orderCount: existingOrderCount, itemCount, issueCount };
    }

    return this.prisma.$transaction(async (transaction) => {
      let orderCount = 0;
      let itemCount = 0;
      let issueCount = 0;

      for (const record of batch.rawRecords) {
        const rawData = record.rawData as RawOrderData;
        const normalized = this.normalizer.normalize(rawData);
        // 导入阶段已经将主订单编号为空的行计为失败，不能再生成空订单。
        if (!normalized.mainOrderNo) continue;

        const order = await transaction.shopOrder.create({
          data: {
            mainOrderNo: normalized.mainOrderNo,
            status: normalized.status,
            payType: normalized.payType,
            orderType: normalized.orderType,
            appChannel: normalized.appChannel,
            payableAmount: normalized.payableAmount,
            merchantIncome: normalized.merchantIncome,
            totalProductAmount: normalized.totalProductAmount,
            totalQuantity: normalized.totalQuantity,
            submittedAt: normalized.submittedAt,
            paidAt: normalized.paidAt,
            finishedAt: normalized.finishedAt,
            promisedDeliveryAt: normalized.promisedDeliveryAt,
            shippedAt: normalized.shippedAt,
            afterSaleStatus: normalized.afterSaleStatus,
            cancelReason: normalized.cancelReason,
            buyerMessage: normalized.buyerMessage,
            merchantRemark: normalized.merchantRemark,
            influencerId: normalized.influencerId,
            influencerNickname: normalized.influencerNickname,
            trafficSource: normalized.trafficSource,
            trafficChannel: normalized.trafficChannel,
            isSampleOrder: normalized.isSampleOrder,
            isChannelProduct: normalized.isChannelProduct,
            batchId,
            rowNumber: record.rowNumber,
            sourceFileName: batch.sourceFileName,
            rawData: record.rawData as Prisma.InputJsonValue,
          },
        });
        orderCount += 1;

        if (normalized.items.length > 0) {
          await transaction.orderItem.createMany({
            data: normalized.items.map((item) => ({
              orderId: order.id,
              subOrderNo: item.subOrderNo,
              productId: item.productId,
              merchantCode: item.merchantCode,
              productTitle: item.productTitle,
              skuCode: item.skuCode,
              quantity: item.quantity,
              productAmount: item.productAmount,
              itemIndex: item.itemIndex,
              batchId,
              rowNumber: record.rowNumber,
              sourceFileName: batch.sourceFileName,
            })),
          });
          itemCount += normalized.items.length;

          const missingProductIssues = normalized.items.flatMap((item) => item.productId ? [] : [{
            issueType: OrderIssueType.PRODUCT_ID_MISSING,
            mainOrderNo: normalized.mainOrderNo,
            orderId: order.id,
            message: '订单商品缺少商品 ID，无法匹配商品成本',
            detail: {
              itemIndex: item.itemIndex,
              productTitle: item.productTitle,
              merchantCode: item.merchantCode,
            } as Prisma.InputJsonValue,
            batchId,
            rowNumber: record.rowNumber,
            sourceFileName: batch.sourceFileName,
          }]);
          if (missingProductIssues.length > 0) {
            await transaction.orderIssue.createMany({ data: missingProductIssues });
            issueCount += missingProductIssues.length;
          }
        }

        if (normalized.issues.length > 0) {
          await transaction.orderIssue.createMany({
            data: normalized.issues.map((issue) => ({
              issueType: OrderIssueType.SPLIT_AMBIGUOUS,
              mainOrderNo: issue.mainOrderNo,
              orderId: order.id,
              message: issue.message,
              detail: issue.detail as Prisma.InputJsonValue,
              batchId,
              rowNumber: record.rowNumber,
              sourceFileName: batch.sourceFileName,
            })),
          });
          issueCount += normalized.issues.length;
        }
      }

      return { batchId, orderCount, itemCount, issueCount };
    });
  }

  async getOrderByMainOrderNo(mainOrderNo: string, settlementBatchId?: string) {
    const order = await this.prisma.shopOrder.findUnique({
      where: { mainOrderNo },
      include: {
        items: {
          orderBy: { itemIndex: 'asc' },
          include: { costSnapshot: { include: { version: true, productCost: true } } },
        },
        settlements: {
          ...(settlementBatchId ? { where: { batchId: settlementBatchId } } : {}),
          orderBy: [{ settledAt: 'asc' }, { rowNumber: 'asc' }],
        },
        liveSession: true,
      },
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    const settlements = order.settlements.length > 0
      ? order.settlements
      : await this.prisma.settlement.findMany({
          where: {
            orderNoFixed: mainOrderNo,
            ...(settlementBatchId ? { batchId: settlementBatchId } : {}),
          },
          orderBy: [{ settledAt: 'asc' }, { rowNumber: 'asc' }],
        });
    const settledAmount = settlements.reduce(
      (sum, settlement) => sum.plus(settlement.amount),
      new Prisma.Decimal(0),
    );
    const snapshots = order.items
      .map((item) => item.costSnapshot)
      .filter((snapshot) => snapshot !== null);
    const allItemsHaveMatchedCost =
      snapshots.length === order.items.length &&
      snapshots.every(
        (snapshot) =>
          snapshot.status === 'MATCHED' ||
          snapshot.status === 'PENDING_VERSION',
      ) &&
      snapshots.every((snapshot) => snapshot.totalCost !== null);
    const totalCost = allItemsHaveMatchedCost
      ? snapshots.reduce(
          (sum, snapshot) => sum.plus(snapshot.totalCost ?? 0),
          new Prisma.Decimal(0),
        )
      : null;
    const costStatus =
      snapshots.length === 0
        ? null
        : snapshots.some((snapshot) => snapshot.status === 'CONFLICT')
            ? 'CONFLICT'
            : snapshots.some((snapshot) => snapshot.status === 'MISSING')
              ? 'MISSING'
              : 'MATCHED';
    const profit =
      settlements.length > 0 && totalCost !== null
        ? settledAmount.minus(totalCost)
        : null;

    return {
      ...order,
      settledAmount: settledAmount.toFixed(2),
      settlements,
      items: order.items.map(({ costSnapshot, ...item }) => ({
        ...item,
        costSnapshot: costSnapshot
          ? {
              ...costSnapshot,
              status:
                costSnapshot.status === 'PENDING_VERSION'
                  ? 'MATCHED'
                  : costSnapshot.status,
              unitCost: costSnapshot.unitCost?.toFixed(2) ?? null,
              totalCost: costSnapshot.totalCost?.toFixed(2) ?? null,
              source: {
                versionId: costSnapshot.versionId,
                sourceFileName: costSnapshot.version.sourceFileName,
                rowNumber: costSnapshot.productCost?.rowNumber ?? null,
                rawData: costSnapshot.productCost?.rawData ?? null,
              },
            }
          : null,
      })),
      costSummary: {
        status: costStatus,
        totalCost: totalCost?.toFixed(2) ?? null,
        profit: profit?.toFixed(2) ?? null,
      },
    };
  }

  async listOrders(page = 1, pageSize = 20, batchId?: string, settlementBatchId?: string) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.min(500, Math.max(1, pageSize));
    const result = await this.prisma.$transaction(async (transaction) => {
      const where = batchId ? { batchId } : undefined;
      const total = await transaction.shopOrder.count({ where });
      const items = await transaction.shopOrder.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { mainOrderNo: 'asc' }],
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        select: {
          id: true,
          mainOrderNo: true,
          status: true,
          submittedAt: true,
          merchantIncome: true,
          ownershipType: true,
          liveMatchStatus: true,
          items: {
            select: {
              id: true,
              costSnapshot: { select: { status: true, totalCost: true } },
            },
          },
        },
      });
      const settlementRows = await transaction.settlement.findMany({
        where: {
          orderNoFixed: { in: items.map((item) => item.mainOrderNo) },
          ...(settlementBatchId ? { batchId: settlementBatchId } : {}),
        },
        select: { orderNoFixed: true, amount: true },
      });
      const settlementsByOrder = new Map<string, Prisma.Decimal>();
      const settledOrderNos = new Set<string>();
      for (const settlement of settlementRows) {
        settledOrderNos.add(settlement.orderNoFixed);
        settlementsByOrder.set(
          settlement.orderNoFixed,
          (settlementsByOrder.get(settlement.orderNoFixed) ?? new Prisma.Decimal(0)).plus(settlement.amount),
        );
      }
      return { total, items, settlementsByOrder, settledOrderNos };
    });
    return {
      total: result.total,
      page: safePage,
      pageSize: safePageSize,
      items: result.items.map(({ items: orderItems, ...order }) => {
        const allCostsMatched = orderItems.length > 0 && orderItems.every((item) =>
          (item.costSnapshot?.status === CostSnapshotStatus.MATCHED ||
            item.costSnapshot?.status === CostSnapshotStatus.PENDING_VERSION) &&
          item.costSnapshot.totalCost !== null,
        );
        const totalCost = allCostsMatched
          ? orderItems.reduce(
              (sum, item) => sum.plus(item.costSnapshot?.totalCost ?? 0),
              new Prisma.Decimal(0),
            )
          : null;
        const settledAmount = result.settlementsByOrder.get(order.mainOrderNo) ?? new Prisma.Decimal(0);
        const hasSettlement = result.settledOrderNos.has(order.mainOrderNo);
        return {
          ...order,
          itemCount: orderItems.length,
          settledAmount: hasSettlement ? settledAmount.toFixed(2) : null,
          costAmount: totalCost?.toFixed(2) ?? null,
          profit: totalCost !== null && hasSettlement
            ? settledAmount.minus(totalCost).toFixed(2)
            : null,
        };
      }),
    };
  }

  async listIssues(orderBatchId?: string, status?: IssueResolutionStatus, settlementBatchId?: string) {
    let issues;
    if (!orderBatchId) {
      issues = await this.prisma.orderIssue.findMany({
        orderBy: [{ createdAt: 'asc' }],
      });
    } else {
      const orders = await this.prisma.shopOrder.findMany({
        where: { batchId: orderBatchId },
        select: { id: true },
      });
      const orderIds = orders.map((order) => order.id);
      const orderNumbers = (await this.prisma.shopOrder.findMany({
        where: { id: { in: orderIds } },
        select: { mainOrderNo: true },
      })).map((order) => order.mainOrderNo);
      const settlementBatch = settlementBatchId
        ? [{ batchId: settlementBatchId }]
        : await this.prisma.settlement.groupBy({
            by: ['batchId'],
            where: {
              OR: [
                ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
                ...(orderNumbers.length > 0 ? [{ orderNoFixed: { in: orderNumbers } }] : []),
              ],
            },
            _count: { _all: true },
            orderBy: { _count: { batchId: 'desc' } },
            take: 1,
          });
      issues = await this.prisma.orderIssue.findMany({
        where: {
          OR: [
            { batchId: orderBatchId },
            {
              orderId: { in: orderIds },
              issueType: {
                in: [
                  OrderIssueType.COST_MISSING,
                  OrderIssueType.COST_CONFLICT,
                  OrderIssueType.LIVE_SESSION_CONFLICT,
                  OrderIssueType.ORDER_TIME_MISSING,
                ],
              },
            },
            ...settlementBatch.map(({ batchId }) => ({ batchId })),
          ],
        },
        orderBy: [{ createdAt: 'asc' }],
      });
    }

    const keys = issues.map((issue) => issueResolutionKey(issue));
    const resolutions = keys.length > 0
      ? await this.prisma.orderIssueResolution.findMany({ where: { issueKey: { in: keys } } })
      : [];
    const resolutionsByKey = new Map(resolutions.map((resolution) => [resolution.issueKey, resolution]));
    const supplementTasks = keys.length > 0
      ? await this.prisma.reconciliationTask.findMany({
          where: { sourceIssueKey: { in: keys } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            sourceIssueKey: true,
            accountingMonth: true,
            status: true,
            supplementTarget: true,
            createdAt: true,
            archivedAt: true,
            orderBatch: { select: { id: true, sourceFileName: true } },
            settlementBatch: { select: { id: true, sourceFileName: true } },
          },
        })
      : [];
    const supplementTasksByIssueKey = new Map<string, typeof supplementTasks>();
    for (const task of supplementTasks) {
      if (!task.sourceIssueKey) continue;
      const linkedTasks = supplementTasksByIssueKey.get(task.sourceIssueKey) ?? [];
      linkedTasks.push(task);
      supplementTasksByIssueKey.set(task.sourceIssueKey, linkedTasks);
    }
    const issueOrderNos = Array.from(new Set(
      issues
        .map((issue) => issue.mainOrderNo)
        .filter((orderNo): orderNo is string => Boolean(orderNo)),
    ));
    const availableOrders = issueOrderNos.length > 0
      ? await this.prisma.shopOrder.findMany({
          where: { mainOrderNo: { in: issueOrderNos } },
          select: { mainOrderNo: true, batchId: true, sourceFileName: true },
        })
      : [];
    const availableOrdersByNo = new Map(availableOrders.map((order) => [order.mainOrderNo, order]));
    const sourceRecordKeys = Array.from(new Set(issues
      .filter((issue) => issue.rowNumber !== null)
      .map((issue) => `${issue.batchId}:${issue.rowNumber}`)));
    const sourceRecords = sourceRecordKeys.length > 0
      ? await this.prisma.rawRecord.findMany({
          where: { OR: sourceRecordKeys.map((key) => { const [batchId, rowNumber] = key.split(':'); return { batchId, rowNumber: Number(rowNumber) }; }) },
          select: { batchId: true, rowNumber: true, rawData: true },
        })
      : [];
    const sourceRecordByKey = new Map(sourceRecords.map((record) => [`${record.batchId}:${record.rowNumber}`, record.rawData]));
    const issueOrderData = issueOrderNos.length > 0
      ? await this.prisma.shopOrder.findMany({ where: { mainOrderNo: { in: [...issueOrderNos] } }, select: { mainOrderNo: true, rawData: true, sourceFileName: true, batchId: true, rowNumber: true } })
      : [];
    const issueOrderDataByNo = new Map(issueOrderData.map((order) => [order.mainOrderNo, order]));
    const issueSettlementData = issueOrderNos.length > 0
      ? await this.prisma.settlement.findMany({ where: { orderNoFixed: { in: [...issueOrderNos] } }, orderBy: { rowNumber: 'asc' }, select: { orderNoFixed: true, rawData: true, sourceFileName: true, batchId: true, rowNumber: true } })
      : [];
    const issueSettlementDataByNo = new Map(issueSettlementData.map((settlement) => [settlement.orderNoFixed, settlement]));
    return issues
      .map((issue) => {
        const issueKey = issueResolutionKey(issue);
        const resolution = resolutionsByKey.get(issueKey);
        const availableOrder = issue.mainOrderNo
          ? availableOrdersByNo.get(issue.mainOrderNo)
          : undefined;
        return {
          ...issue,
          detail: {
            matching: issue.detail,
            sourceRecord: issue.rowNumber === null ? null : sourceRecordByKey.get(`${issue.batchId}:${issue.rowNumber}`) ?? null,
          },
          orderAvailable: Boolean(availableOrder),
          availableOrderBatchId: availableOrder?.batchId ?? null,
          availableOrderSourceFileName: availableOrder?.sourceFileName ?? null,
          resolutionStatus: resolution?.status ?? IssueResolutionStatus.PENDING,
          resolutionNote: resolution?.note ?? null,
          resolvedAt: resolution?.resolvedAt ?? null,
          supplementTasks: supplementTasksByIssueKey.get(issueKey) ?? [],
          sourceRecord: issue.rowNumber === null ? null : {
            batchId: issue.batchId,
            rowNumber: issue.rowNumber,
            sourceFileName: issue.sourceFileName ?? issueOrderDataByNo.get(issue.mainOrderNo ?? '')?.sourceFileName ?? null,
            rawData: sourceRecordByKey.get(`${issue.batchId}:${issue.rowNumber}`)
              ?? (issue.issueType === OrderIssueType.SETTLEMENT_WITHOUT_ORDER || issue.issueType === OrderIssueType.CROSS_PERIOD_SETTLEMENT
                ? issueSettlementDataByNo.get(issue.mainOrderNo ?? '')?.rawData
                : issueOrderDataByNo.get(issue.mainOrderNo ?? '')?.rawData)
              ?? null,
          },
        };
      })
      .filter((issue) => !status || issue.resolutionStatus === status);
  }

  async exportIssues(params: ExportIssueParams = {}) {
    const issues = await this.listIssues(params.orderBatchId, params.status);
    const normalizedQuery = params.query?.trim().toLowerCase();
    const filtered = issues.filter((issue) => {
      const matchesType = !params.issueType || params.issueType === 'ALL' || issue.issueType === params.issueType;
      const matchesQuery = !normalizedQuery
        || issue.mainOrderNo?.toLowerCase().includes(normalizedQuery)
        || issue.message.toLowerCase().includes(normalizedQuery)
        || issue.sourceFileName?.toLowerCase().includes(normalizedQuery);
      return matchesType && matchesQuery;
    });
    const headers = ['异常类型', '订单号', '异常原因', '处理状态', '处理说明', '来源文件', '来源批次', '原始行号', '原始数据'];
    const rows = filtered.map((issue) => [
      issueExportLabels[issue.issueType] ?? issue.issueType,
      issue.mainOrderNo ?? '',
      issue.message,
      issueResolutionExportLabels[issue.resolutionStatus] ?? issue.resolutionStatus,
      issue.resolutionNote ?? '',
      issue.sourceFileName ?? '',
      issue.sourceRecord?.batchId ?? issue.batchId,
      issue.sourceRecord?.rowNumber ?? issue.rowNumber ?? '',
      issue.sourceRecord?.rawData ?? issue.detail ?? '',
    ]);
    const csvCell = (value: unknown) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
      return `"${String(text).replace(/"/g, '""')}"`;
    };
    const csv = `\ufeff${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    const typeSuffix = params.issueType && params.issueType !== 'ALL' ? `_${params.issueType}` : '';
    return {
      fileName: `异常清单${typeSuffix}_${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      content: Buffer.from(csv, 'utf8'),
      count: filtered.length,
    };
  }

  async getIssueSourceContext(issueId: string) {
    const issue = await this.prisma.orderIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw new NotFoundException('来源异常记录不存在，请刷新异常清单后重试');
    return {
      issueKey: issueResolutionKey(issue),
      issueType: issue.issueType,
      mainOrderNo: issue.mainOrderNo,
    };
  }

  async updateIssueResolution(
    issueId: string,
    status: IssueResolutionStatus,
    note?: string,
  ) {
    const issue = await this.prisma.orderIssue.findUnique({ where: { id: issueId } });
    if (!issue) {
      throw new NotFoundException('异常记录不存在');
    }
    const resolution = await this.prisma.orderIssueResolution.upsert({
      where: { issueKey: issueResolutionKey(issue) },
      create: {
        issueKey: issueResolutionKey(issue),
        status,
        note: note?.trim() || null,
        resolvedAt: status === IssueResolutionStatus.RESOLVED ? new Date() : null,
      },
      update: {
        status,
        note: note?.trim() || null,
        resolvedAt: status === IssueResolutionStatus.RESOLVED ? new Date() : null,
      },
    });
    return {
      issueId,
      resolutionStatus: resolution.status,
      resolutionNote: resolution.note,
      resolvedAt: resolution.resolvedAt,
    };
  }

  async getSummary(orderBatchId: string, settlementBatchId?: string) {
    const orderBatch = await this.prisma.importBatch.findUnique({
      where: { id: orderBatchId },
      select: { id: true, sourceFileName: true, dataType: true },
    });
    if (!orderBatch || orderBatch.dataType !== 'DOUYIN_ORDER') {
      throw new NotFoundException('订单批次不存在');
    }

    const orders = await this.prisma.shopOrder.findMany({
      where: { batchId: orderBatchId },
      select: {
        id: true,
        mainOrderNo: true,
        items: {
          select: {
            costSnapshot: {
              select: { status: true, totalCost: true, version: { select: { batchId: true, sourceFileName: true } } },
            },
          },
        },
        liveSession: { select: { batchId: true, sourceFileName: true } },
        settlements: {
          ...(settlementBatchId ? { where: { batchId: settlementBatchId } } : {}),
          select: { amount: true },
        },
      },
    });
    const settlementRows = orders.length === 0
      ? []
      : await this.prisma.settlement.findMany({
          where: {
            orderNoFixed: { in: orders.map((order) => order.mainOrderNo) },
            ...(settlementBatchId ? { batchId: settlementBatchId } : {}),
          },
          select: { orderNoFixed: true, amount: true, batchId: true, sourceFileName: true },
        });
    const settlementsByOrder = new Map<string, typeof settlementRows>();
    for (const settlement of settlementRows) {
      const rows = settlementsByOrder.get(settlement.orderNoFixed) ?? [];
      rows.push(settlement);
      settlementsByOrder.set(settlement.orderNoFixed, rows);
    }
    const orderIds = orders.map((order) => order.id);
    const settlementBatchIds = Array.from(new Set(settlementRows.map((settlement) => settlement.batchId)));
    const sourceFiles = Array.from(new Set([
      orderBatch.sourceFileName,
      ...settlementRows.map((settlement) => settlement.sourceFileName),
      ...orders.flatMap((order) => order.items.flatMap((item) => item.costSnapshot?.version.sourceFileName ?? [])),
      ...orders.flatMap((order) => order.liveSession?.sourceFileName ?? []),
    ]));
    const sourceBatchIds = Array.from(new Set([
      orderBatchId,
      ...settlementBatchIds,
      ...orders.flatMap((order) => order.items.flatMap((item) => item.costSnapshot?.version.batchId ?? [])),
      ...orders.flatMap((order) => order.liveSession?.batchId ?? []),
    ]));
    const issues = await this.prisma.orderIssue.findMany({
      where: {
        OR: [
          {
            batchId: orderBatchId,
            issueType: { not: OrderIssueType.PRODUCT_UNMATCHED },
          },
          ...(orderIds.length > 0 ? [{
            orderId: { in: orderIds },
            issueType: {
              in: [
                OrderIssueType.COST_MISSING,
                OrderIssueType.COST_CONFLICT,
                OrderIssueType.LIVE_SESSION_CONFLICT,
                OrderIssueType.ORDER_TIME_MISSING,
              ],
            },
          }] : []),
          ...(settlementBatchIds.length > 0 ? [{ batchId: { in: settlementBatchIds } }] : []),
        ],
      },
      select: { id: true, issueType: true, mainOrderNo: true },
    });

    const issueOrderNos = new Set(
      issues.filter((issue) => issue.mainOrderNo).map((issue) => issue.mainOrderNo as string),
    );
    let itemCount = 0;
    let matchedCostItemCount = 0;
    let unmatchedCostItemCount = 0;
    let missingCostItemCount = 0;
    let conflictCostItemCount = 0;
    let completeCostOrderCount = 0;
    let settledOrderCount = 0;
    let settlementRecordCount = 0;
    let settlementAmount = new Prisma.Decimal(0);
    let totalCost = new Prisma.Decimal(0);
    let calculableProfit = new Prisma.Decimal(0);
    let profitOrderCount = 0;

    for (const order of orders) {
      const snapshots = order.items.map((item) => item.costSnapshot);
      itemCount += snapshots.length;
      let orderCost = new Prisma.Decimal(0);
      let completeCost = snapshots.length > 0;
      for (const snapshot of snapshots) {
        if (!snapshot) {
          unmatchedCostItemCount += 1;
          completeCost = false;
          continue;
        }
        if (snapshot.status === 'MISSING') {
          missingCostItemCount += 1;
          completeCost = false;
          continue;
        }
        if (snapshot.status === 'CONFLICT') {
          conflictCostItemCount += 1;
          completeCost = false;
          continue;
        }
        if (snapshot.status === 'MATCHED' || snapshot.status === 'PENDING_VERSION') {
          matchedCostItemCount += 1;
          if (snapshot.totalCost === null) {
            completeCost = false;
            continue;
          }
          orderCost = orderCost.plus(snapshot.totalCost);
          continue;
        }
        completeCost = false;
      }
      if (completeCost) {
        completeCostOrderCount += 1;
        totalCost = totalCost.plus(orderCost);
      }

      const orderSettlements = order.settlements.length > 0
        ? order.settlements
        : settlementsByOrder.get(order.mainOrderNo) ?? [];
      const orderSettlementAmount = orderSettlements.reduce(
        (sum, settlement) => sum.plus(settlement.amount),
        new Prisma.Decimal(0),
      );
      if (orderSettlements.length > 0) {
        settledOrderCount += 1;
        settlementRecordCount += orderSettlements.length;
        settlementAmount = settlementAmount.plus(orderSettlementAmount);
        if (completeCost) {
          calculableProfit = calculableProfit.plus(orderSettlementAmount.minus(orderCost));
          profitOrderCount += 1;
        }
      }
    }

    const issueCounts = issues.reduce<Record<string, number>>((counts, issue) => {
      counts[issue.issueType] = (counts[issue.issueType] ?? 0) + 1;
      return counts;
    }, {});
    const normalOrderCount = orders.filter((order) => {
      return !issueOrderNos.has(order.mainOrderNo);
    }).length;

    return {
      orderBatchId,
      sourceFileName: orderBatch.sourceFileName,
      sourceFiles,
      sourceBatchIds,
      orderCount: orders.length,
      itemCount,
      settledOrderCount,
      unsettledOrderCount: orders.length - settledOrderCount,
      settlementRecordCount,
      settlementAmount: settlementAmount.toFixed(2),
      matchedCostItemCount,
      unmatchedCostItemCount,
      missingCostItemCount,
      conflictCostItemCount,
      completeCostOrderCount,
      incompleteCostOrderCount: orders.length - completeCostOrderCount,
      totalCost: totalCost.toFixed(2),
      profitOrderCount,
      calculableProfit: calculableProfit.toFixed(2),
      normalOrderCount,
      issueCount: issues.length,
      issueCounts,
    };
  }

  async getSummaryMonths() {
    const tasks = await this.prisma.reconciliationTask.findMany({
      where: {
        status: 'COMPLETED',
        archivedAt: null,
      },
      select: { accountingMonth: true, updatedAt: true },
      orderBy: [{ accountingMonth: 'desc' }, { updatedAt: 'desc' }],
    });
    const grouped = new Map<string, { taskCount: number; latestCompletedAt: Date | null }>();
    for (const task of tasks) {
      const current = grouped.get(task.accountingMonth) ?? { taskCount: 0, latestCompletedAt: null };
      current.taskCount += 1;
      const completedAt = task.updatedAt;
      if (!current.latestCompletedAt || completedAt > current.latestCompletedAt) {
        current.latestCompletedAt = completedAt;
      }
      grouped.set(task.accountingMonth, current);
    }
    return Array.from(grouped.entries())
      .sort(([monthA], [monthB]) => monthB.localeCompare(monthA))
      .map(([accountingMonth, value]) => ({
        accountingMonth,
        taskCount: value.taskCount,
        completedTaskCount: value.taskCount,
        latestCompletedAt: value.latestCompletedAt,
      }));
  }

  async getMonthlySummary(accountingMonth: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(accountingMonth)) {
      throw new BadRequestException('对账月份格式应为 YYYY-MM');
    }
    const tasks = await this.prisma.reconciliationTask.findMany({
      where: { accountingMonth, status: 'COMPLETED', archivedAt: null },
      select: {
        orderBatchId: true,
        settlementBatchId: true,
        costBatchId: true,
        liveBatchId: true,
      },
    });
    if (tasks.length === 0) {
      throw new NotFoundException('该月份没有已完成的对账任务');
    }

    const orderBatchIds = Array.from(new Set(tasks.map((task) => task.orderBatchId)));
    const settlementBatchIds = Array.from(new Set(tasks.map((task) => task.settlementBatchId)));
    const costBatchIds = Array.from(new Set(tasks.flatMap((task) => task.costBatchId ? [task.costBatchId] : [])));
    const liveBatchIds = Array.from(new Set(tasks.flatMap((task) => task.liveBatchId ? [task.liveBatchId] : [])));
    const orders = await this.prisma.shopOrder.findMany({
      where: { batchId: { in: orderBatchIds } },
      orderBy: [{ createdAt: 'asc' }, { mainOrderNo: 'asc' }],
      select: {
        id: true,
        mainOrderNo: true,
        items: {
          select: {
            costSnapshot: {
              select: { status: true, totalCost: true },
            },
          },
        },
      },
    });
    const uniqueOrders = Array.from(new Map(orders.map((order) => [order.mainOrderNo, order])).values());
    const orderNumbers = uniqueOrders.map((order) => order.mainOrderNo);
    const orderNumberSet = new Set(orderNumbers);
    const settlementRows = orderNumbers.length === 0
      ? []
      : await this.prisma.settlement.findMany({
          where: {
            batchId: { in: settlementBatchIds },
            orderNoFixed: { in: orderNumbers },
          },
          select: { orderNoFixed: true, amount: true, batchId: true, sourceFileName: true },
        });
    const settlementsByOrder = new Map<string, typeof settlementRows>();
    for (const row of settlementRows) {
      const rows = settlementsByOrder.get(row.orderNoFixed) ?? [];
      rows.push(row);
      settlementsByOrder.set(row.orderNoFixed, rows);
    }

    let itemCount = 0;
    let matchedCostItemCount = 0;
    let unmatchedCostItemCount = 0;
    let missingCostItemCount = 0;
    let conflictCostItemCount = 0;
    let completeCostOrderCount = 0;
    let settledOrderCount = 0;
    let settlementRecordCount = 0;
    let settlementAmount = new Prisma.Decimal(0);
    let totalCost = new Prisma.Decimal(0);
    let calculableProfit = new Prisma.Decimal(0);
    let profitOrderCount = 0;
    const issueOrderNos = new Set<string>();

    for (const order of uniqueOrders) {
      const snapshots = order.items.map((item) => item.costSnapshot);
      itemCount += snapshots.length;
      let orderCost = new Prisma.Decimal(0);
      let completeCost = snapshots.length > 0;
      for (const snapshot of snapshots) {
        if (!snapshot) {
          unmatchedCostItemCount += 1;
          completeCost = false;
        } else if (snapshot.status === CostSnapshotStatus.MISSING) {
          missingCostItemCount += 1;
          completeCost = false;
        } else if (snapshot.status === CostSnapshotStatus.CONFLICT) {
          conflictCostItemCount += 1;
          completeCost = false;
        } else if ((snapshot.status === CostSnapshotStatus.MATCHED || snapshot.status === CostSnapshotStatus.PENDING_VERSION) && snapshot.totalCost !== null) {
          matchedCostItemCount += 1;
          orderCost = orderCost.plus(snapshot.totalCost);
        } else {
          completeCost = false;
        }
      }
      if (completeCost) {
        completeCostOrderCount += 1;
        totalCost = totalCost.plus(orderCost);
      }
      const orderSettlements = settlementsByOrder.get(order.mainOrderNo) ?? [];
      if (orderSettlements.length > 0) {
        settledOrderCount += 1;
        settlementRecordCount += orderSettlements.length;
        const orderSettlementAmount = orderSettlements.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
        settlementAmount = settlementAmount.plus(orderSettlementAmount);
        if (completeCost) {
          profitOrderCount += 1;
          calculableProfit = calculableProfit.plus(orderSettlementAmount.minus(orderCost));
        }
      }
    }

    const issues = await this.prisma.orderIssue.findMany({
      where: {
        OR: [
          { batchId: { in: orderBatchIds } },
          ...(orderNumbers.length > 0 ? [{ mainOrderNo: { in: orderNumbers }, issueType: { in: [OrderIssueType.COST_MISSING, OrderIssueType.COST_CONFLICT, OrderIssueType.LIVE_SESSION_CONFLICT, OrderIssueType.ORDER_TIME_MISSING] } }] : []),
          { batchId: { in: settlementBatchIds } },
        ],
      },
      select: { id: true, issueType: true, mainOrderNo: true },
    });
    const issueKeys = new Set<string>();
    const issueCounts = issues.reduce<Record<string, number>>((counts, issue) => {
      const key = `${issue.mainOrderNo ?? issue.id}|${issue.issueType}`;
      if (issueKeys.has(key)) return counts;
      issueKeys.add(key);
      if (issue.mainOrderNo && orderNumberSet.has(issue.mainOrderNo)) issueOrderNos.add(issue.mainOrderNo);
      counts[issue.issueType] = (counts[issue.issueType] ?? 0) + 1;
      return counts;
    }, {});
    const sourceBatches = await this.prisma.importBatch.findMany({
      where: { id: { in: [...new Set([...orderBatchIds, ...settlementBatchIds, ...costBatchIds, ...liveBatchIds])] } },
      select: { id: true, sourceFileName: true },
    });
    const sourceFiles = Array.from(new Set(sourceBatches.map((batch) => batch.sourceFileName)));
    return {
      accountingMonth,
      taskCount: tasks.length,
      orderBatchIds,
      settlementBatchIds,
      costBatchIds,
      liveBatchIds,
      sourceFiles,
      sourceBatchIds: sourceBatches.map((batch) => batch.id),
      orderBatchId: orderBatchIds[0],
      sourceFileName: sourceFiles[0] ?? '',
      orderCount: uniqueOrders.length,
      itemCount,
      settledOrderCount,
      unsettledOrderCount: uniqueOrders.length - settledOrderCount,
      settlementRecordCount,
      settlementAmount: settlementAmount.toFixed(2),
      matchedCostItemCount,
      unmatchedCostItemCount,
      missingCostItemCount,
      conflictCostItemCount,
      completeCostOrderCount,
      incompleteCostOrderCount: uniqueOrders.length - completeCostOrderCount,
      totalCost: totalCost.toFixed(2),
      profitOrderCount,
      calculableProfit: calculableProfit.toFixed(2),
      normalOrderCount: uniqueOrders.length - issueOrderNos.size,
      issueCount: Object.values(issueCounts).reduce((sum, count) => sum + count, 0),
      issueCounts,
    };
  }
}
