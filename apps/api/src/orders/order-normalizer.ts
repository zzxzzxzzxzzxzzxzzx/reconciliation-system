import { Injectable } from '@nestjs/common';

export type RawOrderData = Record<string, string>;

export interface NormalizedItem {
  subOrderNo?: string;
  productId?: string;
  merchantCode?: string;
  productTitle?: string;
  skuCode?: string;
  quantity?: number;
  productAmount?: string;
  itemIndex: number;
}

export interface NormalizedIssue {
  mainOrderNo: string;
  message: string;
  detail: Record<string, unknown>;
}

export interface NormalizedOrder {
  mainOrderNo: string;
  status?: string;
  payType?: string;
  orderType?: string;
  appChannel?: string;
  payableAmount?: string;
  merchantIncome?: string;
  totalProductAmount?: string;
  totalQuantity?: number;
  submittedAt?: Date;
  paidAt?: Date;
  finishedAt?: Date;
  promisedDeliveryAt?: Date;
  shippedAt?: Date;
  afterSaleStatus?: string;
  cancelReason?: string;
  buyerMessage?: string;
  merchantRemark?: string;
  influencerId?: string;
  influencerNickname?: string;
  trafficSource?: string;
  trafficChannel?: string;
  isSampleOrder?: string;
  isChannelProduct?: string;
  items: NormalizedItem[];
  issues: NormalizedIssue[];
}

const MULTI_VALUE_SEPARATOR = ';';

function pick(raw: RawOrderData, key: string): string | undefined {
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
  if (!/^\d+$/.test(normalized)) {
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

function splitMulti(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(MULTI_VALUE_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function extractSkuCode(productTitle: string | undefined): string | undefined {
  if (!productTitle) {
    return undefined;
  }
  const match = productTitle.match(/\(([^()]+)\)\s*$/);
  return match?.[1]?.trim() || undefined;
}

@Injectable()
export class OrderNormalizer {
  normalize(raw: RawOrderData): NormalizedOrder {
    const mainOrderNo = pick(raw, '主订单编号') ?? '';
    const subOrderNos = splitMulti(pick(raw, '子订单编号'));
    const productIds = splitMulti(pick(raw, '商品ID'));
    const merchantCodes = splitMulti(pick(raw, '商家编码'));
    const productTitles = splitMulti(pick(raw, '选购商品'));
    const totalQuantity = parseQuantity(pick(raw, '商品数量'));
    const totalProductAmount = parseAmount(pick(raw, '商品金额'));

    const itemCount = Math.max(
      subOrderNos.length,
      productIds.length,
      merchantCodes.length,
      productTitles.length,
      1,
    );

    const items: NormalizedItem[] = [];
    const issues: NormalizedIssue[] = [];

    if (itemCount === 1) {
      const title = productTitles[0];
      items.push({
        subOrderNo: subOrderNos[0],
        productId: productIds[0],
        merchantCode: merchantCodes[0],
        productTitle: title,
        skuCode: extractSkuCode(title),
        quantity: totalQuantity,
        productAmount: totalProductAmount,
        itemIndex: 0,
      });
    } else {
      const identityCounts = new Set([
        subOrderNos.length,
        productIds.length,
        merchantCodes.length,
        productTitles.length,
      ]);
      const aligned = identityCounts.size === 1;

      // 每行明细至少 1 件商品；当商品数量合计恰好等于拆分行数时，
      // 每行只能是 1 件，属于严格推导而非猜测，可以直接回填数量。
      const perItemQuantity =
        aligned && totalQuantity === itemCount ? 1 : undefined;

      for (let index = 0; index < itemCount; index += 1) {
        const title = aligned ? productTitles[index] : productTitles.join(MULTI_VALUE_SEPARATOR);
        items.push({
          subOrderNo: aligned ? subOrderNos[index] : undefined,
          productId: aligned ? productIds[index] : undefined,
          merchantCode: aligned ? merchantCodes[index] : undefined,
          productTitle: title,
          skuCode: aligned ? extractSkuCode(title) : undefined,
          quantity: perItemQuantity,
          // 商品金额只有订单合计值，无法可靠分摊到单行，始终留空
          productAmount: undefined,
          itemIndex: index,
        });
      }

      if (!aligned) {
        issues.push({
          mainOrderNo,
          message: '多商品字段数量不一致，无法自动对应，已保留原始拼接值',
          detail: {
            subOrderCount: subOrderNos.length,
            productIdCount: productIds.length,
            merchantCodeCount: merchantCodes.length,
            productTitleCount: productTitles.length,
            aligned,
            totalQuantity: pick(raw, '商品数量'),
            totalProductAmount: pick(raw, '商品金额'),
          },
        });
      } else if (perItemQuantity === undefined) {
        issues.push({
          mainOrderNo,
          message:
            totalQuantity === undefined
              ? `多商品订单已按子订单拆分 ${itemCount} 行，但缺少商品数量合计值，单行数量留空待人工核对`
              : `多商品订单已按子订单拆分 ${itemCount} 行，商品数量合计 ${totalQuantity} 无法分摊（每行至少 1 件），单行数量留空待人工核对`,
          detail: {
            subOrderCount: subOrderNos.length,
            productIdCount: productIds.length,
            merchantCodeCount: merchantCodes.length,
            productTitleCount: productTitles.length,
            aligned,
            totalQuantity: pick(raw, '商品数量'),
            totalProductAmount: pick(raw, '商品金额'),
          },
        });
      }
    }

    return {
      mainOrderNo,
      status: pick(raw, '订单状态'),
      payType: pick(raw, '支付方式'),
      orderType: pick(raw, '订单类型'),
      appChannel: pick(raw, 'APP渠道'),
      payableAmount: parseAmount(pick(raw, '订单应付金额')),
      merchantIncome: parseAmount(pick(raw, '商家收入金额')),
      totalProductAmount,
      totalQuantity,
      submittedAt: parseDateTime(pick(raw, '订单提交时间')),
      paidAt: parseDateTime(pick(raw, '支付完成时间')),
      finishedAt: parseDateTime(pick(raw, '订单完成时间')),
      promisedDeliveryAt: parseDateTime(pick(raw, '承诺发货时间')),
      shippedAt: parseDateTime(pick(raw, '发货时间')),
      afterSaleStatus: pick(raw, '售后状态'),
      cancelReason: pick(raw, '取消原因'),
      buyerMessage: pick(raw, '买家留言'),
      merchantRemark: pick(raw, '商家备注'),
      influencerId: pick(raw, '达人ID'),
      influencerNickname: pick(raw, '达人昵称'),
      trafficSource: pick(raw, '流量来源'),
      trafficChannel: pick(raw, '流量渠道'),
      isSampleOrder: pick(raw, '是否属于寄样订单'),
      isChannelProduct: pick(raw, '是否是渠道商品'),
      items,
      issues,
    };
  }
}
