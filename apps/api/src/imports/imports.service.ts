import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ImportDataType, ImportStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma.service';
import { normalizeOriginalFileName } from './file-name';
import { OrderFileParser } from './order-file.parser';

type BatchWithErrors = Prisma.ImportBatchGetPayload<{ include: { errors: true } }>;

interface ImportConfig {
  dataType: ImportDataType;
  requiredHeader: string;
  requiredMessage: string;
  parseErrorMessage: string;
  skipRow?: (rawData: Record<string, string>) => boolean;
  transformRow?: (rawData: Record<string, string>) => Record<string, string>;
}

const ORDER_IMPORT_CONFIG: ImportConfig = {
  dataType: ImportDataType.DOUYIN_ORDER,
  requiredHeader: '主订单编号',
  requiredMessage: '主订单编号不能为空',
  parseErrorMessage: '订单文件内容无法解析',
};

const SETTLEMENT_IMPORT_CONFIG: ImportConfig = {
  dataType: ImportDataType.DOUYIN_SETTLEMENT,
  requiredHeader: '订单号',
  requiredMessage: '订单号不能为空',
  parseErrorMessage: '结算文件内容无法解析',
  skipRow: (rawData) => {
    const orderNo = rawData['订单号']?.trim() ?? '';
    // 抖店结算表第一行是字段说明（“收入+支出”等注释），订单号列不是数字
    return !/^'?\d+$/.test(orderNo.replace(/[\s']/g, ''));
  },
  transformRow: (rawData) => {
    const orderNo = rawData['订单号'] ?? '';
    const subOrderNo = rawData['子订单号'] ?? '';
    return {
      ...rawData,
      订单号修复: orderNo.replace(/[\s']/g, ''),
      子订单号修复: subOrderNo.replace(/[\s']/g, ''),
    };
  },
};

const COST_IMPORT_CONFIG: ImportConfig = {
  dataType: ImportDataType.DOUYIN_COST,
  requiredHeader: '商品id修复',
  requiredMessage: '商品id修复不能为空',
  parseErrorMessage: '成本文件内容无法解析',
  transformRow: (rawData) => ({
    ...rawData,
    商品ID: (rawData['商品ID'] ?? '').replace(/[\s']/g, ''),
    商品id修复: (rawData['商品id修复'] ?? '').replace(/[\s']/g, ''),
    '商品id 和 编码集合': (rawData['商品id 和 编码集合'] ?? '').replace(
      /[\s']/g,
      '',
    ),
  }),
};

const LIVE_IMPORT_CONFIG: ImportConfig = {
  dataType: ImportDataType.DOUYIN_LIVE,
  requiredHeader: '直播开始时间',
  requiredMessage: '直播开始时间不能为空',
  parseErrorMessage: '直播明细文件内容无法解析',
};

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: OrderFileParser,
  ) {}

  importOrders(file: Express.Multer.File) {
    return this.importFile(file, ORDER_IMPORT_CONFIG);
  }

  importSettlements(file: Express.Multer.File) {
    return this.importFile(file, SETTLEMENT_IMPORT_CONFIG);
  }

  importCosts(file: Express.Multer.File) {
    return this.importFile(file, COST_IMPORT_CONFIG);
  }

  importLiveSessions(file: Express.Multer.File) {
    return this.importFile(file, LIVE_IMPORT_CONFIG);
  }

  private async importFile(file: Express.Multer.File, config: ImportConfig) {
    this.parser.assertSupported(file.originalname);
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const existingBatch = await this.findBatchByHash(config.dataType, fileHash);

    if (existingBatch) {
      return this.handleExistingBatch(existingBatch);
    }

    let batch;
    try {
      batch = await this.prisma.importBatch.create({
        data: {
          dataType: config.dataType,
          sourceFileName: normalizeOriginalFileName(file.originalname),
          fileHash,
          originalFile: file.buffer,
          mimeType: file.mimetype || 'application/octet-stream',
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const concurrentBatch = await this.findBatchByHash(
          config.dataType,
          fileHash,
        );
        if (concurrentBatch) {
          return this.handleExistingBatch(concurrentBatch);
        }
      }
      throw error;
    }

    let parsed;
    try {
      parsed = await this.parser.parse(file);
    } catch {
      await this.prisma.$transaction([
        this.prisma.importError.create({
          data: {
            batchId: batch.id,
            code: 'FILE_PARSE_ERROR',
            message: config.parseErrorMessage,
          },
        }),
        this.prisma.importBatch.update({
          where: { id: batch.id },
          data: { status: ImportStatus.FAILED, completedAt: new Date() },
        }),
      ]);
      this.throwFailedBatch(batch.id, config.parseErrorMessage);
    }

    const hasRequiredHeader = parsed.headers.includes(config.requiredHeader);
    const dataRows = hasRequiredHeader
      ? parsed.rows
          .map((rawData, index) => ({ rawData, index }))
          .filter(({ rawData }) => !config.skipRow?.(rawData))
      : [];

    const rawRecords = parsed.rows.map((rawData, index) => ({
      batchId: batch.id,
      rowNumber: index + 2,
      rawData: (config.transformRow?.(rawData) ??
        rawData) as Prisma.InputJsonValue,
    }));

    const errors: Prisma.ImportErrorCreateManyInput[] = hasRequiredHeader
      ? dataRows.flatMap(({ rawData, index }) => {
          if (rawData[config.requiredHeader]?.trim()) {
            return [];
          }
          return [
            {
              batchId: batch.id,
              rowNumber: index + 2,
              code: 'MISSING_REQUIRED_VALUE',
              message: config.requiredMessage,
              rawData: rawData as Prisma.InputJsonValue,
            },
          ];
        })
      : [
          {
            batchId: batch.id,
            rowNumber: null,
            code: 'MISSING_REQUIRED_HEADER',
            message: `缺少必填字段：${config.requiredHeader}`,
          },
        ];
    const totalRows = hasRequiredHeader ? dataRows.length : parsed.rows.length;
    const failedRows = hasRequiredHeader ? errors.length : totalRows;
    const successRows = totalRows - failedRows;
    const completedStatus = !hasRequiredHeader
      ? ImportStatus.FAILED
      : failedRows > 0
        ? ImportStatus.COMPLETED_WITH_ERRORS
        : ImportStatus.COMPLETED;

    const completedBatch = await this.prisma.$transaction(async (transaction) => {
      if (rawRecords.length > 0) {
        await transaction.rawRecord.createMany({ data: rawRecords });
      }
      if (errors.length > 0) {
        await transaction.importError.createMany({ data: errors });
      }

      return transaction.importBatch.update({
        where: { id: batch.id },
        data: {
          status: completedStatus,
          totalRows,
          successRows,
          failedRows,
          completedAt: new Date(),
        },
      });
    });

    if (!hasRequiredHeader) {
      this.throwFailedBatch(batch.id, `缺少必填字段：${config.requiredHeader}`);
    }

    return { duplicate: false, batch: completedBatch };
  }

  async getBatch(batchId: string) {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { errors: { orderBy: [{ rowNumber: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!batch) {
      throw new NotFoundException('导入批次不存在');
    }
    return batch;
  }

  async listBatches(dataType?: string, includeArchived = false) {
    const supportedDataTypes = Object.values(ImportDataType);
    if (dataType && !supportedDataTypes.includes(dataType as ImportDataType)) {
      throw new BadRequestException('不支持的数据类型');
    }

    const batches = await this.prisma.importBatch.findMany({
      where: {
        ...(dataType ? { dataType: dataType as ImportDataType } : {}),
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      select: {
        id: true,
        dataType: true,
        status: true,
        sourceFileName: true,
        fileHash: true,
        totalRows: true,
        successRows: true,
        failedRows: true,
        duplicateRows: true,
        createdAt: true,
        completedAt: true,
        archivedAt: true,
        _count: {
          select: {
            reconciliationOrderTasks: true,
            reconciliationSettlementTasks: true,
            reconciliationCostTasks: true,
            reconciliationLiveTasks: true,
            orders: true,
            settlements: true,
            liveSessions: true,
            qianchuanSpends: true,
          },
        },
        costVersion: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return batches.map((batch) => {
      const taskUsage = batch._count.reconciliationOrderTasks
        + batch._count.reconciliationSettlementTasks
        + batch._count.reconciliationCostTasks
        + batch._count.reconciliationLiveTasks;
      const hasProtectedGeneratedData = batch._count.orders > 0
        || batch._count.settlements > 0
        || batch._count.liveSessions > 0
        || Boolean(batch.costVersion);
      return {
        ...batch,
        sourceFileName: normalizeOriginalFileName(batch.sourceFileName),
        canDelete: taskUsage === 0 && !hasProtectedGeneratedData,
        deleteBlockedReason: taskUsage > 0
          ? '已被对账任务使用，只能归档'
          : hasProtectedGeneratedData
            ? '已生成业务数据，只能归档'
            : null,
      };
    });
  }

  async setArchived(batchId: string, archived: boolean) {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('导入批次不存在');
    return this.prisma.importBatch.update({
      where: { id: batchId },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  async setManyArchived(batchIds: string[] | undefined, archived: boolean) {
    const uniqueBatchIds = [...new Set(batchIds ?? [])];
    if (uniqueBatchIds.length === 0) {
      throw new BadRequestException('请选择需要操作的导入批次');
    }
    if (uniqueBatchIds.length > 100) {
      throw new BadRequestException('单次最多操作 100 个导入批次');
    }

    const batches = await this.prisma.importBatch.findMany({
      where: { id: { in: uniqueBatchIds } },
      select: { id: true },
    });
    if (batches.length !== uniqueBatchIds.length) {
      throw new NotFoundException('部分导入批次不存在，请刷新后重试');
    }

    const archivedAt = archived ? new Date() : null;
    const result = await this.prisma.importBatch.updateMany({
      where: { id: { in: uniqueBatchIds } },
      data: { archivedAt },
    });
    return { count: result.count, archivedAt };
  }

  async deleteBatch(batchId: string) {
    const batches = await this.getDeletableBatchCandidates([batchId]);
    if (batches.length === 0) {
      throw new NotFoundException('导入批次不存在');
    }
    this.assertDeletable(batches[0]);
    await this.prisma.importBatch.delete({ where: { id: batchId } });
    return { deleted: true, batchId };
  }

  async deleteManyBatches(batchIds: string[] | undefined) {
    const uniqueBatchIds = [...new Set(batchIds ?? [])];
    if (uniqueBatchIds.length === 0) {
      throw new BadRequestException('请选择需要操作的导入批次');
    }
    if (uniqueBatchIds.length > 100) {
      throw new BadRequestException('单次最多操作 100 个导入批次');
    }

    const batches = await this.getDeletableBatchCandidates(uniqueBatchIds);
    if (batches.length !== uniqueBatchIds.length) {
      throw new NotFoundException('部分导入批次不存在，请刷新后重试');
    }
    batches.forEach((batch) => this.assertDeletable(batch));
    const result = await this.prisma.importBatch.deleteMany({ where: { id: { in: uniqueBatchIds } } });
    return { deleted: true, count: result.count, batchIds: uniqueBatchIds };
  }

  private getDeletableBatchCandidates(batchIds: string[]) {
    return this.prisma.importBatch.findMany({
      where: { id: { in: batchIds } },
      include: {
        _count: {
          select: {
            orders: true,
            settlements: true,
            liveSessions: true,
            qianchuanSpends: true,
            reconciliationOrderTasks: true,
            reconciliationSettlementTasks: true,
            reconciliationCostTasks: true,
            reconciliationLiveTasks: true,
          },
        },
        costVersion: { select: { id: true } },
      },
    });
  }

  private assertDeletable(batch: {
    _count: {
      orders: number;
      settlements: number;
      liveSessions: number;
      qianchuanSpends: number;
      reconciliationOrderTasks: number;
      reconciliationSettlementTasks: number;
      reconciliationCostTasks: number;
      reconciliationLiveTasks: number;
    };
    costVersion: { id: string } | null;
  }) {
    const taskUsage = batch._count.reconciliationOrderTasks
      + batch._count.reconciliationSettlementTasks
      + batch._count.reconciliationCostTasks
      + batch._count.reconciliationLiveTasks;
    const hasProtectedGeneratedData = batch._count.orders > 0
      || batch._count.settlements > 0
      || batch._count.liveSessions > 0
      || Boolean(batch.costVersion);
    if (taskUsage > 0) {
      throw new ConflictException('该批次已被对账任务使用，只能归档，不能删除');
    }
    if (hasProtectedGeneratedData) {
      throw new ConflictException('该批次已生成业务数据，只能归档，不能删除');
    }
  }

  async getRawRecords(batchId: string) {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      throw new NotFoundException('导入批次不存在');
    }

    const items = await this.prisma.rawRecord.findMany({
      where: { batchId },
      orderBy: { rowNumber: 'asc' },
    });

    return { items };
  }

  async downloadRawFile(batchId: string) {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rawRecords: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('导入批次不存在');
    if (batch.originalFile) {
      return {
        fileName: normalizeOriginalFileName(batch.sourceFileName),
        contentType: batch.mimeType ?? 'application/octet-stream',
        content: Buffer.from(batch.originalFile),
        original: true,
      };
    }
    const records = batch.rawRecords.map((record) => record.rawData as Record<string, unknown>);
    const headers = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [headers, ...records.map((record) => headers.map((header) => record[header] ?? ''))];
    const csv = lines.map((line) => line.map(quote).join(',')).join('\n');
    return { fileName: normalizeOriginalFileName(batch.sourceFileName).replace(/\.(xlsx|xls|csv)$/i, '') + '-原始数据.csv', contentType: 'text/csv; charset=utf-8', content: Buffer.from(`\ufeff${csv}`, 'utf8'), original: false };
  }

  private throwFailedBatch(batchId: string, message: string): never {
    throw new UnprocessableEntityException({
      message,
      batchId,
      status: ImportStatus.FAILED,
    });
  }

  private findBatchByHash(dataType: ImportDataType, fileHash: string) {
    return this.prisma.importBatch.findUnique({
      where: {
        dataType_fileHash: {
          dataType,
          fileHash,
        },
      },
      include: { errors: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
  }

  private async handleExistingBatch(batch: BatchWithErrors) {
    if (batch.status === ImportStatus.FAILED) {
      this.throwFailedBatch(
        batch.id,
        batch.errors[0]?.message ?? '文件导入失败',
      );
    }
    const activeBatch = batch.archivedAt
      ? await this.prisma.importBatch.update({
          where: { id: batch.id },
          data: { archivedAt: null },
          include: { errors: { orderBy: { createdAt: 'asc' }, take: 1 } },
        })
      : batch;
    return { duplicate: true, batch: activeBatch, restored: Boolean(batch.archivedAt) };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }
}
