import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, ImportDataType, ImportStatus } from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma.service';
import { normalizeOriginalFileName } from '../imports/file-name';
import { OrderFileParser, ParsedOrderFile } from '../imports/order-file.parser';

export const QIANCHUAN_ACCOUNTS = ['小象汉字01', '百香果01', '朱颜'] as const;
export type QianchuanAccount = (typeof QIANCHUAN_ACCOUNTS)[number];

const ALIASES = {
  date: ['日期', '消耗日期', '数据日期'],
  totalSpend: ['余额总消耗(元)', '余额总消耗', '总消耗(元)', '总消耗'],
  nonGiftSpend: ['非赠款消耗(元)', '非赠款消耗'],
  giftSpend: ['赠款消耗(元)', '赠款消耗'],
  redPacketSpend: ['消返红包消耗(元)', '消返红包消耗'],
  discountSpend: ['立减红包消耗(元)', '立减红包消耗'],
  sharedWalletSpend: ['共享钱包消耗(元)', '共享钱包消耗'],
  sharedGiftSpend: ['共享赠款消耗(元)', '共享赠款消耗'],
} as const;

const INVALID_QIANCHUAN_FILE_MESSAGE = '文件格式不符合千川消耗表要求，请确认包含日期、余额总消耗和消耗分类字段';

type SpendField = keyof typeof ALIASES;
type RawRow = Record<string, string>;

function valueFor(row: RawRow, aliases: readonly string[]) {
  const key = aliases.find((candidate) => Object.prototype.hasOwnProperty.call(row, candidate));
  return key ? row[key]?.trim() ?? '' : '';
}

function parseAmount(value: string) {
  const normalized = value.replace(/[,¥￥\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(normalized) ? new Prisma.Decimal(normalized) : null;
}

function parseDate(value: string) {
  const match = value.trim().match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function activeSpendWhere(where: Prisma.QianchuanSpendWhereInput): Prisma.QianchuanSpendWhereInput {
  return { ...where, batch: { archivedAt: null } };
}

function resolveHeaders(parsed: ParsedOrderFile) {
  const resolved = {} as Record<SpendField, string | undefined>;
  for (const field of Object.keys(ALIASES) as SpendField[]) {
    resolved[field] = ALIASES[field].find((header) => parsed.headers.includes(header));
  }
  return resolved;
}

function isQianchuanHeaders(headers: Record<SpendField, string | undefined>) {
  const hasSpendCategory = [
    headers.nonGiftSpend,
    headers.giftSpend,
    headers.redPacketSpend,
    headers.discountSpend,
    headers.sharedWalletSpend,
    headers.sharedGiftSpend,
  ].some(Boolean);
  return Boolean(headers.date && headers.totalSpend && hasSpendCategory);
}

function serializeSpend<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (key === 'sourceFileName' && typeof value === 'string') return [key, normalizeOriginalFileName(value)];
    return [key, value instanceof Prisma.Decimal ? value.toFixed(2) : value];
  }));
}

@Injectable()
export class QianchuanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: OrderFileParser,
  ) {}

  async importSpend(file: Express.Multer.File, accountName: string) {
    if (!QIANCHUAN_ACCOUNTS.includes(accountName as QianchuanAccount)) {
      throw new BadRequestException(`千川账号无效，可选：${QIANCHUAN_ACCOUNTS.join('、')}`);
    }
    this.parser.assertSupported(file.originalname);
    const sourceFileName = normalizeOriginalFileName(file.originalname);
    const fileHash = createHash('sha256')
      .update(accountName)
      .update('\0')
      .update(file.buffer)
      .digest('hex');
    const existing = await this.prisma.importBatch.findUnique({
      where: { dataType_fileHash: { dataType: ImportDataType.QIANCHUAN_SPEND, fileHash } },
      include: { rawRecords: { orderBy: { rowNumber: 'asc' }, take: 1 } },
    });
    if (existing) {
      const firstRawData = existing.rawRecords[0]?.rawData;
      const existingHeaders = firstRawData && typeof firstRawData === 'object' && !Array.isArray(firstRawData)
        ? resolveHeaders({ headers: Object.keys(firstRawData), rows: [] })
        : null;
      if (!existingHeaders || !isQianchuanHeaders(existingHeaders)) {
        throw new BadRequestException(INVALID_QIANCHUAN_FILE_MESSAGE);
      }
      const wasArchived = Boolean(existing.archivedAt);
      const batch = existing.archivedAt
        ? await this.prisma.importBatch.update({ where: { id: existing.id }, data: { archivedAt: null } })
        : existing;
      return { duplicate: true, restored: wasArchived, batch };
    }

    const batch = await this.prisma.importBatch.create({
      data: {
        dataType: ImportDataType.QIANCHUAN_SPEND,
        sourceFileName,
        fileHash,
        originalFile: file.buffer,
        mimeType: file.mimetype || 'application/octet-stream',
      },
    });

    let parsed: ParsedOrderFile;
    try {
      parsed = await this.parser.parse(file);
    } catch {
      await this.prisma.$transaction([
        this.prisma.importError.create({ data: { batchId: batch.id, code: 'FILE_PARSE_ERROR', message: '千川消耗文件内容无法解析' } }),
        this.prisma.importBatch.update({ where: { id: batch.id }, data: { status: ImportStatus.FAILED, completedAt: new Date() } }),
      ]);
      throw new BadRequestException('千川消耗文件内容无法解析');
    }

    const headers = resolveHeaders(parsed);
    if (!isQianchuanHeaders(headers)) {
      await this.prisma.$transaction([
        this.prisma.importError.create({ data: { batchId: batch.id, code: 'INVALID_QIANCHUAN_FILE', message: INVALID_QIANCHUAN_FILE_MESSAGE } }),
        this.prisma.importBatch.update({ where: { id: batch.id }, data: { status: ImportStatus.FAILED, totalRows: parsed.rows.length, failedRows: parsed.rows.length, completedAt: new Date() } }),
      ]);
      throw new BadRequestException({ message: INVALID_QIANCHUAN_FILE_MESSAGE, batchId: batch.id });
    }

    const rawRecords = parsed.rows.map((rawData, index) => ({
      batchId: batch.id,
      rowNumber: index + 2,
      rawData: rawData as Prisma.InputJsonValue,
    }));
    const errors: Prisma.ImportErrorCreateManyInput[] = [];
    const spends: Prisma.QianchuanSpendCreateManyInput[] = [];
    parsed.rows.forEach((rawData, index) => {
      const dateText = valueFor(rawData, ALIASES.date);
      // 文件首行“总计”是汇总值，不应再次计入日明细。
      if (dateText === '总计' || !dateText && Object.values(rawData).every((value) => !value)) return;
      const spendDate = parseDate(dateText);
      const totalSpend = parseAmount(valueFor(rawData, ALIASES.totalSpend));
      if (!spendDate || !totalSpend) {
        errors.push({ batchId: batch.id, rowNumber: index + 2, code: 'INVALID_SPEND_ROW', message: '日期或总消耗金额无效', rawData: rawData as Prisma.InputJsonValue });
        return;
      }
      spends.push({
        batchId: batch.id,
        accountName,
        spendDate,
        totalSpend,
        nonGiftSpend: parseAmount(valueFor(rawData, ALIASES.nonGiftSpend)),
        giftSpend: parseAmount(valueFor(rawData, ALIASES.giftSpend)),
        redPacketSpend: parseAmount(valueFor(rawData, ALIASES.redPacketSpend)),
        discountSpend: parseAmount(valueFor(rawData, ALIASES.discountSpend)),
        sharedWalletSpend: parseAmount(valueFor(rawData, ALIASES.sharedWalletSpend)),
        sharedGiftSpend: parseAmount(valueFor(rawData, ALIASES.sharedGiftSpend)),
        rawData: rawData as Prisma.InputJsonValue,
        rowNumber: index + 2,
        sourceFileName,
      });
    });

    const completed = await this.prisma.$transaction(async (tx) => {
      if (rawRecords.length) await tx.rawRecord.createMany({ data: rawRecords });
      if (errors.length) await tx.importError.createMany({ data: errors });
      if (spends.length) await tx.qianchuanSpend.createMany({ data: spends, skipDuplicates: true });
      return tx.importBatch.update({
        where: { id: batch.id },
        data: {
          totalRows: spends.length + errors.length,
          successRows: spends.length,
          failedRows: errors.length,
          duplicateRows: Math.max(0, spends.length - (await tx.qianchuanSpend.count({ where: { batchId: batch.id } }))),
          status: errors.length ? ImportStatus.COMPLETED_WITH_ERRORS : ImportStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
    });
    return { duplicate: false, batch: completed, accountName };
  }

  async list(params: { accountName?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where = this.buildWhere(params);
    const activeWhere = activeSpendWhere(where);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.qianchuanSpend.findMany({ where: activeWhere, orderBy: [{ spendDate: 'desc' }, { accountName: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.qianchuanSpend.count({ where: activeWhere }),
    ]);
    return { items: items.map((item) => serializeSpend(item)), total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async summary(params: { accountName?: string; from?: string; to?: string }) {
    const rows = await this.prisma.qianchuanSpend.findMany({ where: activeSpendWhere(this.buildWhere(params)) });
    const fields = ['totalSpend', 'nonGiftSpend', 'giftSpend', 'redPacketSpend', 'discountSpend', 'sharedWalletSpend', 'sharedGiftSpend'] as const;
    return fields.reduce<Record<string, string | number>>((result, field) => {
      result[field] = rows.reduce((sum, row) => sum.plus(row[field] ?? 0), new Prisma.Decimal(0)).toFixed(2);
      return result;
    }, { rowCount: rows.length });
  }

  async export(params: { accountName?: string; from?: string; to?: string }) {
    const rows = await this.prisma.qianchuanSpend.findMany({ where: activeSpendWhere(this.buildWhere(params)), orderBy: [{ spendDate: 'desc' }, { accountName: 'asc' }] });
    const headers = ['账号', '日期', '总消耗', '非赠款消耗', '赠款消耗', '消返红包', '立减红包', '共享钱包', '共享赠款', '来源文件'];
    const lines = [headers, ...rows.map((row) => [row.accountName, row.spendDate.toISOString().slice(0, 10), row.totalSpend, row.nonGiftSpend, row.giftSpend, row.redPacketSpend, row.discountSpend, row.sharedWalletSpend, row.sharedGiftSpend, normalizeOriginalFileName(row.sourceFileName)])];
    return lines.map((line) => line.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  private buildWhere(params: { accountName?: string; from?: string; to?: string }): Prisma.QianchuanSpendWhereInput {
    if (params.accountName && !QIANCHUAN_ACCOUNTS.includes(params.accountName as QianchuanAccount)) throw new BadRequestException('千川账号无效');
    const from = params.from ? parseDate(params.from) : undefined;
    const to = params.to ? parseDate(params.to) : undefined;
    if (params.from && !from || params.to && !to) throw new BadRequestException('日期格式应为 YYYY-MM-DD');
    if (from && to && from > to) throw new BadRequestException('开始日期不能晚于结束日期');
    return { accountName: params.accountName, spendDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } };
  }
}
