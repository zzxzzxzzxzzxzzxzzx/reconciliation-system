import { Injectable } from '@nestjs/common';

export type RawSettlementData = Record<string, string>;

export interface NormalizedSettlement {
  orderNoFixed: string;
  subOrderNoFixed?: string;
  settledAt?: Date;
  amount: string;
  account?: string;
  settlementType?: string;
  hasRefundBefore?: string;
  orderedAt?: Date;
  productId?: string;
  productName?: string;
  productQuantity?: number;
  influencerId?: string;
  influencerName?: string;
  businessType?: string;
  orderType?: string;
  orderTotalPrice?: string;
  productTotalPrice?: string;
  shippingFee?: string;
  incomeTotal?: string;
  expenseTotal?: string;
  platformServiceFee?: string;
  influencerCommission?: string;
  merchantEntity?: string;
  appChannel?: string;
  remark?: string;
}

function pick(raw: RawSettlementData, key: string): string | undefined {
  const value = raw[key]?.trim();
  return value ? value : undefined;
}

function parseAmount(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/[,¥￥\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function parseQuantity(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/[,\s]/g, '');
  if (!/^-?\d+$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseDateTime(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(' ', 'T');
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}+08:00`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function cleanOrderNo(value: string | undefined): string {
  return (value ?? '').replace(/[\s']/g, '');
}

@Injectable()
export class SettlementNormalizer {
  normalize(raw: RawSettlementData): NormalizedSettlement {
    const orderNoFixed = pick(raw, '订单号修复') ?? cleanOrderNo(raw['订单号']);
    const subOrderNoFixed =
      pick(raw, '子订单号修复') ?? (cleanOrderNo(raw['子订单号']) || undefined);
    const amount = parseAmount(pick(raw, '结算金额')) ?? '0';

    return {
      orderNoFixed,
      subOrderNoFixed,
      settledAt: parseDateTime(pick(raw, '结算时间')),
      amount,
      account: pick(raw, '结算账户'),
      settlementType: pick(raw, '结算单类型'),
      hasRefundBefore: pick(raw, '有结算前退款'),
      orderedAt: parseDateTime(pick(raw, '下单时间')),
      productId: pick(raw, '商品ID'),
      productName: pick(raw, '商品名称'),
      productQuantity: parseQuantity(pick(raw, '商品数量')),
      influencerId: pick(raw, '达人ID'),
      influencerName: pick(raw, '达人名称'),
      businessType: pick(raw, '业务类型'),
      orderType: pick(raw, '订单类型'),
      orderTotalPrice: parseAmount(pick(raw, '订单总价')),
      productTotalPrice: parseAmount(pick(raw, '商品总价')),
      shippingFee: parseAmount(pick(raw, '运费')),
      incomeTotal: parseAmount(pick(raw, '收入合计')),
      expenseTotal: parseAmount(pick(raw, '支出合计')),
      platformServiceFee: parseAmount(pick(raw, '平台服务费')),
      influencerCommission: parseAmount(pick(raw, '达人佣金')),
      merchantEntity: pick(raw, '商户主体名称'),
      appChannel: pick(raw, 'APP渠道'),
      remark: pick(raw, '备注'),
    };
  }
}
