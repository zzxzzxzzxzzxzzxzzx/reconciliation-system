import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CostSnapshotStatus,
  CostVersionStatus,
  ImportStatus,
  ImportDataType,
  OrderIssueType,
  Prisma,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../infrastructure/prisma.service';

type RawCostData = Record<string, string>;

function cleanIdentifier(value: string | undefined): string {
  return (value ?? '').replace(/[\s']/g, '');
}

function parseUnitCost(value: string | undefined): string | undefined {
  const normalized = (value ?? '').replace(/[,¥￥\s]/g, '');
  return /^\d+(\.\d+)?$/.test(normalized) ? normalized : undefined;
}

function normalizeCostRow(rawData: RawCostData) {
  const productId = cleanIdentifier(rawData['商品id修复']);
  const compositeValue = cleanIdentifier(rawData['商品id 和 编码集合']);
  const merchantCode = compositeValue.startsWith(productId)
    ? compositeValue.slice(productId.length)
    : '';

  return {
    productId,
    merchantCode,
    compositeKey: `${productId}|${merchantCode}`,
    productName: rawData['商品名称']?.trim() || undefined,
    unitCost: parseUnitCost(rawData['成本']),
    remark: rawData['备注']?.trim() || undefined,
  };
}

type ManualCostChangeInput = {
  changeType?: string;
  productId?: string;
  merchantCode?: string;
  productName?: string;
  unitCost?: string | number;
  reason?: string;
  effectiveFrom?: string;
};

function positiveInteger(value: number | undefined, fallback: number, maximum: number) {
  return Number.isInteger(value) && (value ?? 0) > 0
    ? Math.min(value as number, maximum)
    : fallback;
}

function csvCell(value: unknown) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

@Injectable()
export class CostsService {
  constructor(private readonly prisma: PrismaService) {}

  async listVersions(params: { page?: number; pageSize?: number } = {}) {
    const page = positiveInteger(params.page, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = positiveInteger(params.pageSize, 20, 100);
    const [versions, total] = await Promise.all([
      this.prisma.costVersion.findMany({
        where: { batch: { archivedAt: null } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          batch: { select: { id: true, sourceFileName: true, createdAt: true } },
          _count: { select: { costs: true, snapshots: true } },
        },
      }),
      this.prisma.costVersion.count({ where: { batch: { archivedAt: null } } }),
    ]);
    return {
      items: versions.map((version) => ({
        id: version.id,
        batchId: version.batchId,
        status: version.status,
        effectiveFrom: version.effectiveFrom,
        sourceFileName: version.sourceFileName,
        sourceType: version.sourceFileName.startsWith('人工成本版本_') ? 'MANUAL' : 'FILE',
        createdAt: version.createdAt,
        costRowCount: version._count.costs,
        snapshotCount: version._count.snapshots,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async listVersionItems(
    versionId: string,
    params: { query?: string; page?: number; pageSize?: number } = {},
  ) {
    const version = await this.prisma.costVersion.findUnique({
      where: { id: versionId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('成本版本不存在');
    const page = positiveInteger(params.page, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = positiveInteger(params.pageSize, 20, 100);
    const query = params.query?.trim();
    const where: Prisma.ProductCostWhereInput = {
      versionId,
      ...(query
        ? {
            OR: [
              { productId: { contains: query, mode: 'insensitive' } },
              { merchantCode: { contains: query, mode: 'insensitive' } },
              { productName: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.productCost.findMany({
        where,
        orderBy: [{ productId: 'asc' }, { merchantCode: 'asc' }, { rowNumber: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.productCost.count({ where }),
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        unitCost: item.unitCost?.toFixed(2) ?? null,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async createManualVersion(baseVersionId: string, input: ManualCostChangeInput) {
    const changeType = input.changeType === 'ADD' || input.changeType === 'CORRECT'
      ? input.changeType
      : null;
    if (!changeType) throw new BadRequestException('维护方式只能是新增成本或更正成本');
    const productId = cleanIdentifier(input.productId);
    const merchantCode = cleanIdentifier(input.merchantCode);
    const productName = input.productName?.trim() || undefined;
    const unitCost = parseUnitCost(String(input.unitCost ?? ''));
    const reason = input.reason?.trim();
    if (!productId || !merchantCode || !unitCost || !reason) {
      throw new BadRequestException('商品 ID、商家编码、单位成本和修改原因不能为空');
    }
    let effectiveFrom: Date | null = null;
    if (input.effectiveFrom) {
      effectiveFrom = new Date(`${input.effectiveFrom}T00:00:00+08:00`);
      if (Number.isNaN(effectiveFrom.getTime())) {
        throw new BadRequestException('开始适用日期格式不正确');
      }
    }
    if (changeType === 'CORRECT' && !effectiveFrom) {
      throw new BadRequestException('更正成本时必须填写开始适用日期');
    }

    const baseVersion = await this.prisma.costVersion.findUnique({
      where: { id: baseVersionId },
      include: { costs: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!baseVersion) throw new NotFoundException('基础成本版本不存在');
    const compositeKey = `${productId}|${merchantCode}`;
    const matchingRows = baseVersion.costs.filter((cost) => cost.compositeKey === compositeKey);
    if (changeType === 'ADD' && matchingRows.length > 0) {
      throw new BadRequestException('该商品成本已存在，请使用“更正成本”');
    }
    if (changeType === 'CORRECT' && matchingRows.length === 0) {
      throw new BadRequestException('基础版本中没有该商品，请使用“新增成本”');
    }

    const retainedRows = changeType === 'CORRECT'
      ? baseVersion.costs.filter((cost) => cost.compositeKey !== compositeKey)
      : baseVersion.costs;
    const sourceFileName = `人工成本版本_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}.csv`;
    const changedRawData = {
      商品ID: productId,
      商品名称: productName ?? '',
      '商品id 和 编码集合': `${productId}${merchantCode}`,
      成本: unitCost,
      备注: reason,
      商品id修复: productId,
      维护方式: changeType === 'ADD' ? '新增成本' : '更正成本',
      基础成本版本: baseVersionId,
      开始适用日期: input.effectiveFrom ?? '',
    };
    const resultingRows = [
      ...retainedRows.map((cost) => ({
        productId: cost.productId,
        merchantCode: cost.merchantCode,
        compositeKey: cost.compositeKey,
        productName: cost.productName,
        unitCost: cost.unitCost?.toFixed(2),
        remark: cost.remark,
        rawData: cost.rawData as Prisma.InputJsonValue,
      })),
      {
        productId,
        merchantCode,
        compositeKey,
        productName,
        unitCost,
        remark: reason,
        rawData: changedRawData as Prisma.InputJsonValue,
      },
    ];
    const headers = ['商品ID', '商品名称', '商家编码', '成本', '备注', '维护方式', '基础成本版本', '开始适用日期'];
    const csvRows = resultingRows.map((row) => {
      const raw = row.rawData as Record<string, unknown>;
      return [
        row.productId,
        row.productName,
        row.merchantCode,
        row.unitCost,
        row.remark,
        raw['维护方式'] ?? '继承',
        raw['基础成本版本'] ?? baseVersionId,
        raw['开始适用日期'] ?? '',
      ];
    });
    const originalFile = Buffer.from(
      `\ufeff${[headers, ...csvRows].map((row) => row.map(csvCell).join(',')).join('\n')}`,
      'utf8',
    );
    const fileHash = createHash('sha256')
      .update(`${baseVersionId}:${randomUUID()}:${originalFile.toString('base64')}`)
      .digest('hex');

    const created = await this.prisma.$transaction(async (transaction) => {
      const batch = await transaction.importBatch.create({
        data: {
          dataType: ImportDataType.DOUYIN_COST,
          status: ImportStatus.COMPLETED,
          sourceFileName,
          fileHash,
          originalFile,
          mimeType: 'text/csv; charset=utf-8',
          totalRows: resultingRows.length,
          successRows: resultingRows.length,
          completedAt: new Date(),
        },
      });
      const version = await transaction.costVersion.create({
        data: {
          batchId: batch.id,
          status: CostVersionStatus.ACTIVE,
          effectiveFrom,
          sourceFileName,
        },
      });
      await transaction.rawRecord.createMany({
        data: resultingRows.map((row, index) => ({
          batchId: batch.id,
          rowNumber: index + 2,
          rawData: row.rawData,
        })),
      });
      await transaction.productCost.createMany({
        data: resultingRows.map((row, index) => ({
          versionId: version.id,
          productId: row.productId,
          merchantCode: row.merchantCode,
          compositeKey: row.compositeKey,
          productName: row.productName,
          unitCost: row.unitCost,
          remark: row.remark,
          rowNumber: index + 2,
          rawData: row.rawData,
        })),
      });
      return { batch, version };
    });

    return {
      id: created.version.id,
      batchId: created.batch.id,
      baseVersionId,
      changeType,
      effectiveFrom: created.version.effectiveFrom,
      sourceFileName,
      costRowCount: resultingRows.length,
      changedProduct: { productId, merchantCode, productName, unitCost },
    };
  }

  async standardizeBatch(batchId: string, orderBatchId?: string) {
    if (!orderBatchId) {
      throw new BadRequestException('请指定需要匹配的订单批次');
    }

    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rawRecords: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) {
      throw new NotFoundException('导入批次不存在');
    }
    if (batch.dataType !== ImportDataType.DOUYIN_COST) {
      throw new BadRequestException('该批次不是成本数据');
    }

    const orderBatch = await this.prisma.importBatch.findUnique({
      where: { id: orderBatchId },
      select: { id: true },
    });
    if (!orderBatch) {
      throw new NotFoundException('订单批次不存在');
    }

    return this.prisma.$transaction(async (transaction) => {
      let version = await transaction.costVersion.findUnique({
        where: { batchId },
      });
      if (!version) {
        version = await transaction.costVersion.create({
          data: {
            batchId,
            status: CostVersionStatus.ACTIVE,
            sourceFileName: batch.sourceFileName,
          },
        });
      } else if (version.status !== CostVersionStatus.ACTIVE) {
        version = await transaction.costVersion.update({
          where: { id: version.id },
          data: { status: CostVersionStatus.ACTIVE },
        });
      }

      const existingCostRowCount = await transaction.productCost.count({
        where: { versionId: version.id },
      });
      if (existingCostRowCount === 0) {
        const normalizedCostRows = batch.rawRecords.flatMap((record) => {
          const rawData = record.rawData as RawCostData;
          const normalized = normalizeCostRow(rawData);
          if (!normalized.productId) {
            return [];
          }
          return [
            {
              versionId: version.id,
              productId: normalized.productId,
              merchantCode: normalized.merchantCode,
              compositeKey: normalized.compositeKey,
              productName: normalized.productName,
              unitCost: normalized.unitCost,
              remark: normalized.remark,
              rowNumber: record.rowNumber,
              rawData: record.rawData as Prisma.InputJsonValue,
            },
          ];
        });
        if (normalizedCostRows.length > 0) {
          await transaction.productCost.createMany({
            data: normalizedCostRows,
          });
        }
      }

      const [costRows, orderItemCount, orderItems] = await Promise.all([
        transaction.productCost.findMany({
          where: { versionId: version.id },
          orderBy: { rowNumber: 'asc' },
        }),
        transaction.orderItem.count({ where: { batchId: orderBatchId } }),
        transaction.orderItem.findMany({
          where: {
            batchId: orderBatchId,
            OR: [
              { costSnapshot: { is: null } },
              {
                costSnapshot: {
                  is: {
                    status: {
                      in: [
                        CostSnapshotStatus.MISSING,
                        CostSnapshotStatus.CONFLICT,
                      ],
                    },
                  },
                },
              },
            ],
          },
          include: {
            order: {
              select: {
                id: true,
                mainOrderNo: true,
                submittedAt: true,
                rowNumber: true,
                sourceFileName: true,
              },
            },
          },
          orderBy: [{ rowNumber: 'asc' }, { itemIndex: 'asc' }],
        }),
      ]);
      if (orderItems.length > 0) {
        const orderItemIds = orderItems.map((item) => item.id);
        const orderIds = Array.from(
          new Set(orderItems.map((item) => item.order.id)),
        );
        await transaction.orderItemCostSnapshot.deleteMany({
          where: { orderItemId: { in: orderItemIds } },
        });
        await transaction.orderIssue.deleteMany({
          where: {
            orderId: { in: orderIds },
            issueType: {
              in: [OrderIssueType.COST_MISSING, OrderIssueType.PRODUCT_UNMATCHED, OrderIssueType.COST_CONFLICT],
            },
          },
        });
      }

      const costsByVersion = new Map<string, typeof costRows>([[version.id, costRows]]);
      const loadedVersionIds = new Set([version.id]);
      let ancestorVersionIds = this.getBaseVersionIds(costRows);
      while (ancestorVersionIds.length > 0) {
        const unloadedVersionIds = ancestorVersionIds.filter((id) => !loadedVersionIds.has(id));
        if (unloadedVersionIds.length === 0) break;
        const ancestorRows = await transaction.productCost.findMany({
          where: { versionId: { in: unloadedVersionIds } },
          orderBy: { rowNumber: 'asc' },
        });
        for (const versionId of unloadedVersionIds) {
          loadedVersionIds.add(versionId);
          costsByVersion.set(
            versionId,
            ancestorRows.filter((row) => row.versionId === versionId),
          );
        }
        ancestorVersionIds = this.getBaseVersionIds(ancestorRows);
      }

      const costsByVersionAndKey = new Map<string, typeof costRows>();
      for (const [versionId, versionRows] of costsByVersion) {
        for (const costRow of versionRows) {
          if (!costRow.unitCost) continue;
          const key = `${versionId}:${costRow.compositeKey}`;
          const rows = costsByVersionAndKey.get(key) ?? [];
          rows.push(costRow);
          costsByVersionAndKey.set(key, rows);
        }
      }

      let matchedItemCount = 0;
      let missingCostCount = 0;
      let conflictCostCount = 0;

      for (const item of orderItems) {
        const productId = cleanIdentifier(item.productId ?? undefined);
        const merchantCode = cleanIdentifier(item.merchantCode ?? undefined);
        const compositeKey = `${productId}|${merchantCode}`;
        const candidates = this.resolveCostRows(
          version.id,
          compositeKey,
          item.order.submittedAt,
          costsByVersionAndKey,
        );
        const costsByValue = new Map<string, (typeof candidates)[number]>();
        for (const candidate of candidates) {
          if (candidate.unitCost) {
            costsByValue.set(candidate.unitCost.toFixed(2), candidate);
          }
        }

        if (costsByValue.size === 1) {
          const candidate = [...costsByValue.values()][0];
          const totalCost = item.quantity
            ? candidate.unitCost?.mul(item.quantity)
            : undefined;
          await transaction.orderItemCostSnapshot.create({
            data: {
              orderItemId: item.id,
              versionId: candidate.versionId,
              productCostId: candidate.id,
              status: CostSnapshotStatus.MATCHED,
              unitCost: candidate.unitCost,
              quantity: item.quantity,
              totalCost,
            },
          });
          matchedItemCount += 1;
          continue;
        }

        const conflict = costsByValue.size > 1;
        await transaction.orderItemCostSnapshot.create({
          data: {
            orderItemId: item.id,
            versionId: version.id,
            status: conflict
              ? CostSnapshotStatus.CONFLICT
              : CostSnapshotStatus.MISSING,
            quantity: item.quantity,
          },
        });
        await transaction.orderIssue.create({
          data: {
            issueType: conflict
              ? OrderIssueType.COST_CONFLICT
              : OrderIssueType.COST_MISSING,
            mainOrderNo: item.order.mainOrderNo,
            orderId: item.order.id,
            message: conflict
              ? `商品成本存在多个值（商品 ID：${productId}，商家编码：${merchantCode}）`
              : `未找到商品成本（商品 ID：${productId}，商家编码：${merchantCode}）`,
            detail: {
              productId,
              merchantCode,
              candidateCosts: [...costsByValue.keys()],
              costVersionId: version.id,
            },
            batchId,
            rowNumber: item.order.rowNumber,
            sourceFileName: item.order.sourceFileName,
          },
        });
        if (!conflict) {
          await transaction.orderIssue.create({
            data: {
              issueType: OrderIssueType.PRODUCT_UNMATCHED,
              mainOrderNo: item.order.mainOrderNo,
              orderId: item.order.id,
              message: `商品无法匹配成本表（商品 ID：${productId}，商家编码：${merchantCode}）`,
              detail: {
                productId,
                merchantCode,
                costVersionId: version.id,
              },
              batchId,
              rowNumber: item.order.rowNumber,
              sourceFileName: item.order.sourceFileName,
            },
          });
        }
        if (conflict) {
          conflictCostCount += 1;
        } else {
          missingCostCount += 1;
        }
      }

      return {
        batchId,
        orderBatchId,
        costVersionId: version.id,
        costRowCount: costRows.length,
        eligibleItemCount: orderItems.length,
        preservedItemCount: orderItemCount - orderItems.length,
        matchedItemCount,
        missingCostCount,
        conflictCostCount,
        versionStatus: CostVersionStatus.ACTIVE,
      };
    });
  }

  private getBaseVersionIds(rows: Array<{ rawData: Prisma.JsonValue }>) {
    return Array.from(new Set(rows.flatMap((row) => {
      const rawData = row.rawData as Record<string, unknown>;
      const baseVersionId = rawData['基础成本版本'];
      return rawData['维护方式'] === '更正成本' && typeof baseVersionId === 'string'
        ? [baseVersionId]
        : [];
    })));
  }

  private resolveCostRows<T extends { rawData: Prisma.JsonValue }>(
    versionId: string,
    compositeKey: string,
    orderedAt: Date | null,
    costsByVersionAndKey: Map<string, T[]>,
    visited = new Set<string>(),
  ): T[] {
    if (visited.has(versionId)) return [];
    visited.add(versionId);
    const rows = costsByVersionAndKey.get(`${versionId}:${compositeKey}`) ?? [];
    const correctionRow = rows.find((row) => {
      const rawData = row.rawData as Record<string, unknown>;
      return rawData['维护方式'] === '更正成本';
    });
    if (!correctionRow || !orderedAt) return rows;
    const rawData = correctionRow.rawData as Record<string, unknown>;
    const effectiveFromValue = rawData['开始适用日期'];
    const baseVersionId = rawData['基础成本版本'];
    if (typeof effectiveFromValue !== 'string' || typeof baseVersionId !== 'string') return rows;
    const effectiveFrom = new Date(`${effectiveFromValue}T00:00:00+08:00`);
    if (Number.isNaN(effectiveFrom.getTime()) || orderedAt >= effectiveFrom) return rows;
    return this.resolveCostRows(
      baseVersionId,
      compositeKey,
      orderedAt,
      costsByVersionAndKey,
      visited,
    );
  }
}
