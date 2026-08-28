import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ImportDataType, OrderIssueType, ReconciliationTaskStatus } from '@prisma/client';
import { CostsService } from '../costs/costs.service';
import { PrismaService } from '../infrastructure/prisma.service';
import { LiveSessionsService } from '../live-sessions/live-sessions.service';
import { OrdersService } from '../orders/orders.service';
import { SettlementsService } from '../settlements/settlements.service';

type CreateTaskInput = {
  accountingMonth?: string;
  orderBatchId?: string;
  settlementBatchId?: string;
  costBatchId?: string;
  liveBatchId?: string;
  sourceIssueId?: string;
  supplementTarget?: string;
};

type OrderBatchReuseResult = {
  orderBatchId: string;
  orderBatchReused: boolean;
  orderBatchReuseMessage?: string;
};

type TaskIdentity = {
  accountingMonth: string;
  orderBatchId: string;
  settlementBatchId: string;
  costBatchId: string | null;
  liveBatchId: string | null;
  sourceIssueKey: string | null;
  supplementTarget: ImportDataType | null;
};

const issueSupplementTarget: Partial<Record<OrderIssueType, ImportDataType>> = {
  [OrderIssueType.COST_MISSING]: ImportDataType.DOUYIN_COST,
  [OrderIssueType.COST_CONFLICT]: ImportDataType.DOUYIN_COST,
  [OrderIssueType.PRODUCT_UNMATCHED]: ImportDataType.DOUYIN_COST,
  [OrderIssueType.ORDER_WITHOUT_SETTLEMENT]: ImportDataType.DOUYIN_SETTLEMENT,
  [OrderIssueType.SETTLEMENT_WITHOUT_ORDER]: ImportDataType.DOUYIN_ORDER,
  [OrderIssueType.PRODUCT_ID_MISSING]: ImportDataType.DOUYIN_ORDER,
  [OrderIssueType.ORDER_TIME_MISSING]: ImportDataType.DOUYIN_ORDER,
  [OrderIssueType.SPLIT_AMBIGUOUS]: ImportDataType.DOUYIN_ORDER,
  [OrderIssueType.LIVE_SESSION_CONFLICT]: ImportDataType.DOUYIN_LIVE,
};

const taskInclude = {
  orderBatch: true,
  settlementBatch: true,
  costBatch: true,
  liveBatch: true,
} as const;

@Injectable()
export class ReconciliationTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly settlementsService: SettlementsService,
    private readonly costsService: CostsService,
    private readonly liveSessionsService: LiveSessionsService,
  ) {}

  async create(input: CreateTaskInput) {
    if (!input.accountingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.accountingMonth)) {
      throw new BadRequestException('对账月份格式应为 YYYY-MM');
    }
    if (!input.orderBatchId || !input.settlementBatchId) {
      throw new BadRequestException('订单批次和结算批次不能为空');
    }
    if (Boolean(input.sourceIssueId) !== Boolean(input.supplementTarget)) {
      throw new BadRequestException('来源异常和补充数据类型必须同时提供');
    }

    const sourceIssue = input.sourceIssueId
      ? await this.ordersService.getIssueSourceContext(input.sourceIssueId)
      : null;
    const supplementTarget = input.supplementTarget
      && Object.values(ImportDataType).includes(input.supplementTarget as ImportDataType)
      ? input.supplementTarget as ImportDataType
      : null;
    if (input.supplementTarget && !supplementTarget) {
      throw new BadRequestException('补充数据类型无效');
    }
    if (sourceIssue && issueSupplementTarget[sourceIssue.issueType] !== supplementTarget) {
      throw new BadRequestException('补充数据类型与来源异常不匹配');
    }

    const orderBatchReuse = await this.resolveOrderBatch(input.orderBatchId);
    const batchIds = [
      orderBatchReuse.orderBatchId,
      input.settlementBatchId,
      input.costBatchId,
      input.liveBatchId,
    ].filter((value): value is string => Boolean(value));
    const batches = await this.prisma.importBatch.findMany({
      where: { id: { in: batchIds } },
      select: { id: true, dataType: true, status: true, successRows: true },
    });
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    this.assertBatch(batchById, orderBatchReuse.orderBatchId, ImportDataType.DOUYIN_ORDER, '订单');
    this.assertBatch(batchById, input.settlementBatchId, ImportDataType.DOUYIN_SETTLEMENT, '结算');
    if (input.costBatchId) this.assertBatch(batchById, input.costBatchId, ImportDataType.DOUYIN_COST, '成本');
    if (input.liveBatchId) this.assertBatch(batchById, input.liveBatchId, ImportDataType.DOUYIN_LIVE, '直播');

    const taskIdentity: TaskIdentity = {
      accountingMonth: input.accountingMonth,
      orderBatchId: orderBatchReuse.orderBatchId,
      settlementBatchId: input.settlementBatchId,
      costBatchId: input.costBatchId || null,
      liveBatchId: input.liveBatchId || null,
      sourceIssueKey: sourceIssue?.issueKey ?? null,
      supplementTarget,
    };
    const existingTasks = await this.prisma.reconciliationTask.findMany({
      where: taskIdentity,
      orderBy: { createdAt: 'asc' },
      include: taskInclude,
    });
    let existingTask = existingTasks.find((task) => task.status === ReconciliationTaskStatus.COMPLETED)
      ?? existingTasks.find((task) => task.status === ReconciliationTaskStatus.PROCESSING)
      ?? existingTasks[0];
    if (existingTask) {
      if (existingTask.archivedAt) {
        existingTask = await this.prisma.reconciliationTask.update({
          where: { id: existingTask.id },
          data: { archivedAt: null },
          include: taskInclude,
        });
      }
      return {
        ...existingTask,
        ...orderBatchReuse,
        duplicate: true,
        duplicateMessage: '相同对账任务已存在，未重复创建',
      };
    }

    return this.prisma.reconciliationTask.create({
      data: {
        ...taskIdentity,
        sourceIssueType: sourceIssue?.issueType ?? null,
        sourceIssueOrderNo: sourceIssue?.mainOrderNo ?? null,
      },
      include: taskInclude,
    }).then((task) => ({ ...task, ...orderBatchReuse }));
  }

  async list(includeArchived = false) {
    const tasks = await this.prisma.reconciliationTask.findMany({
      orderBy: [{ accountingMonth: 'desc' }, { createdAt: 'desc' }],
      include: taskInclude,
    });
    const identityCounts = new Map<string, number>();
    const completedIdentityCounts = new Map<string, number>();
    for (const task of tasks) {
      const identity = this.identityKey(task);
      identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
      if (task.status === ReconciliationTaskStatus.COMPLETED) {
        completedIdentityCounts.set(identity, (completedIdentityCounts.get(identity) ?? 0) + 1);
      }
    }
    return tasks.filter((task) => includeArchived || !task.archivedAt).map((task) => {
      const identity = this.identityKey(task);
      const canDelete = task.status !== ReconciliationTaskStatus.PROCESSING
        && (task.status !== ReconciliationTaskStatus.COMPLETED || (completedIdentityCounts.get(identity) ?? 0) > 1);
      return {
        ...task,
        canDelete,
        deleteBlockedReason: canDelete
          ? null
          : task.status === ReconciliationTaskStatus.PROCESSING
            ? '任务正在处理中，不能删除'
            : '已完成任务没有重复记录，只能归档',
        duplicateCount: identityCounts.get(identity) ?? 1,
      };
    });
  }

  async setArchived(id: string, archived: boolean) {
    await this.get(id);
    return this.prisma.reconciliationTask.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
      include: taskInclude,
    });
  }

  async deleteTask(id: string) {
    const task = await this.get(id);
    if (task.status === ReconciliationTaskStatus.PROCESSING) {
      throw new ConflictException('任务正在处理中，不能删除');
    }
    if (task.status === ReconciliationTaskStatus.COMPLETED) {
      const completedDuplicateCount = await this.prisma.reconciliationTask.count({
        where: {
          id: { not: id },
          ...this.identityWhere(task),
          status: ReconciliationTaskStatus.COMPLETED,
        },
      });
      if (completedDuplicateCount === 0) {
        throw new ConflictException('已完成任务没有重复记录，只能归档');
      }
    }
    await this.prisma.reconciliationTask.delete({ where: { id } });
    return { deleted: true, taskId: id };
  }

  async get(id: string) {
    const task = await this.prisma.reconciliationTask.findUnique({
      where: { id },
      include: taskInclude,
    });
    if (!task) throw new NotFoundException('对账任务不存在');
    return task;
  }

  async run(id: string) {
    let task = await this.get(id);
    const orderBatchReuse = await this.resolveOrderBatch(task.orderBatchId);
    if (orderBatchReuse.orderBatchId !== task.orderBatchId) {
      task = await this.prisma.reconciliationTask.update({
        where: { id },
        data: { orderBatchId: orderBatchReuse.orderBatchId },
        include: taskInclude,
      });
    }
    const locked = await this.prisma.reconciliationTask.updateMany({
      where: { id, status: { not: ReconciliationTaskStatus.PROCESSING } },
      data: { status: ReconciliationTaskStatus.PROCESSING, errorMessage: null },
    });
    if (locked.count !== 1) {
      throw new ConflictException('该对账任务正在处理中，请勿重复启动');
    }
    try {
      const orderResult = await this.ordersService.standardizeBatch(task.orderBatchId);
      const settlementResult = await this.settlementsService.standardizeBatch(
        task.settlementBatchId,
        task.orderBatchId,
      );
      const costResult = task.costBatchId
        ? await this.costsService.standardizeBatch(task.costBatchId, task.orderBatchId)
        : null;
      const liveResult = task.liveBatchId
        ? await this.liveSessionsService.standardizeBatch(task.liveBatchId, task.orderBatchId)
        : null;
      const summary = await this.ordersService.getSummary(task.orderBatchId, task.settlementBatchId);
      const completedTask = await this.prisma.reconciliationTask.update({
        where: { id },
        data: { status: ReconciliationTaskStatus.COMPLETED },
        include: taskInclude,
      });
      return { task: completedTask, orderResult, settlementResult, costResult, liveResult, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : '对账处理失败';
      await this.prisma.reconciliationTask.update({
        where: { id },
        data: { status: ReconciliationTaskStatus.FAILED, errorMessage: message },
      });
      throw error;
    }
  }

  private assertBatch(
    batches: Map<string, { dataType: ImportDataType; status: string; successRows: number }>,
    id: string,
    expectedType: ImportDataType,
    label: string,
  ) {
    const batch = batches.get(id);
    if (!batch) throw new BadRequestException(`${label}批次不存在`);
    if (batch.dataType !== expectedType) throw new BadRequestException(`${label}批次类型不正确`);
    if (batch.status === 'FAILED' || batch.successRows === 0) throw new BadRequestException(`${label}批次没有可用数据`);
  }

  private async resolveOrderBatch(orderBatchId: string): Promise<OrderBatchReuseResult> {
    const records = await this.prisma.rawRecord.findMany({
      where: { batchId: orderBatchId },
      select: { rawData: true },
    });
    if (records.length === 0) {
      return { orderBatchId, orderBatchReused: false };
    }

    const orderNumbers = Array.from(new Set(records.flatMap((record) => {
      const rawData = record.rawData as Record<string, unknown>;
      const value = typeof rawData['主订单编号'] === 'string'
        ? rawData['主订单编号'].trim()
        : '';
      return value ? [value] : [];
    })));
    if (orderNumbers.length === 0) {
      return { orderBatchId, orderBatchReused: false };
    }

    const existingOrders = await this.prisma.shopOrder.findMany({
      where: { mainOrderNo: { in: orderNumbers } },
      select: { mainOrderNo: true, batchId: true },
    });
    if (existingOrders.length === 0) {
      return { orderBatchId, orderBatchReused: false };
    }

    const existingBatchIds = Array.from(new Set(existingOrders.map((order) => order.batchId)));
    if (existingOrders.length === orderNumbers.length && existingBatchIds.length === 1) {
      return {
        orderBatchId: existingBatchIds[0],
        orderBatchReused: true,
        orderBatchReuseMessage: '检测到订单号全部已存在，已自动使用原订单批次',
      };
    }

    throw new ConflictException(
      `订单文件中有 ${existingOrders.length} 个订单号已在其他批次处理过，请改用原订单批次或仅上传新增订单`,
    );
  }

  private identityWhere(task: TaskIdentity) {
    return {
      accountingMonth: task.accountingMonth,
      orderBatchId: task.orderBatchId,
      settlementBatchId: task.settlementBatchId,
      costBatchId: task.costBatchId,
      liveBatchId: task.liveBatchId,
      sourceIssueKey: task.sourceIssueKey,
      supplementTarget: task.supplementTarget,
    };
  }

  private identityKey(task: TaskIdentity) {
    return [
      task.accountingMonth,
      task.orderBatchId,
      task.settlementBatchId,
      task.costBatchId ?? '',
      task.liveBatchId ?? '',
      task.sourceIssueKey ?? '',
      task.supplementTarget ?? '',
    ].join('|');
  }
}
