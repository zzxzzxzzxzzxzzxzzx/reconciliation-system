import {
  SettlementNormalizer,
  cleanOrderNo,
} from './settlement-normalizer';

describe('SettlementNormalizer', () => {
  let normalizer: SettlementNormalizer;

  beforeEach(() => {
    normalizer = new SettlementNormalizer();
  });

  it('清理订单号中的引号和空格', () => {
    expect(cleanOrderNo("'6927400681426288524")).toBe('6927400681426288524');
    expect(cleanOrderNo(" '6927400681426288524 ")).toBe('6927400681426288524');
    expect(cleanOrderNo('')).toBe('');
    expect(cleanOrderNo(undefined)).toBe('');
  });

  it('正常结算记录字段完整解析', () => {
    const result = normalizer.normalize({
      订单号修复: '6927400681426288524',
      子订单号修复: '6927400681426288524',
      结算时间: '2026-07-01 05:59:20',
      结算金额: '97.02',
      结算账户: '聚合账户',
      结算单类型: '已结算',
      下单时间: '2026-06-24 10:51:58',
      收入合计: '109.00',
      支出合计: '11.98',
      平台服务费: '5.45',
      达人佣金: '6.53',
    });

    expect(result.orderNoFixed).toBe('6927400681426288524');
    expect(result.amount).toBe('97.02');
    expect(result.settlementType).toBe('已结算');
    expect(result.settledAt).toBeInstanceOf(Date);
    expect(result.orderedAt).toBeInstanceOf(Date);
    expect(result.incomeTotal).toBe('109.00');
    expect(result.platformServiceFee).toBe('5.45');
    expect(result.influencerCommission).toBe('6.53');
  });

  it('退款负数金额按负数保留', () => {
    const result = normalizer.normalize({
      订单号修复: '6952827502292309061',
      结算金额: '-8',
      结算单类型: '结算后退款-非原路退回',
    });

    expect(result.amount).toBe('-8');
    expect(result.settlementType).toBe('结算后退款-非原路退回');
  });

  it('缺少订单号修复字段时从原始订单号清理', () => {
    const result = normalizer.normalize({
      订单号: "'6952827502292309061",
      子订单号: "'6952827502292309061",
      结算金额: '10.00',
    });

    expect(result.orderNoFixed).toBe('6952827502292309061');
    expect(result.subOrderNoFixed).toBe('6952827502292309061');
  });

  it('非法金额回退为 0，非法时间为空', () => {
    const result = normalizer.normalize({
      订单号修复: '100',
      结算金额: '收入+支出',
      结算时间: '结算时间',
    });

    expect(result.amount).toBe('0');
    expect(result.settledAt).toBeUndefined();
  });
});
