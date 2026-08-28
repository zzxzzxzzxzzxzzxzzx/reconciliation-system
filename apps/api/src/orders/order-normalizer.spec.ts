import { OrderNormalizer } from './order-normalizer';

describe('OrderNormalizer', () => {
  let normalizer: OrderNormalizer;

  beforeEach(() => {
    normalizer = new OrderNormalizer();
  });

  it('单商品行生成一条明细，数量和金额直接落到明细', () => {
    const result = normalizer.normalize({
      主订单编号: '6928379562962288321',
      子订单编号: '6928379562962288321',
      选购商品: '某课程-(PT013)',
      商品ID: '3833758316891341594',
      商家编码: 'PT013',
      商品数量: '1',
      商品金额: '69.00',
      订单应付金额: '69.00',
      商家收入金额: '69.00',
      订单提交时间: '2026-07-31 15:56:21',
      订单状态: '已发货',
      支付方式: '抖音支付',
    });

    expect(result.mainOrderNo).toBe('6928379562962288321');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      subOrderNo: '6928379562962288321',
      productId: '3833758316891341594',
      merchantCode: 'PT013',
      skuCode: 'PT013',
      quantity: 1,
      productAmount: '69.00',
      itemIndex: 0,
    });
    expect(result.issues).toHaveLength(0);
    expect(result.payableAmount).toBe('69.00');
    expect(result.submittedAt).toBeInstanceOf(Date);
  });

  it('多商品行数量合计等于行数时，按位置对齐拆分并回填每行数量 1，不记问题', () => {
    const result = normalizer.normalize({
      主订单编号: '6928358141972479308',
      子订单编号: '6928358141972479308;6928358141972544844',
      选购商品: '商品A-(PT013);商品B-(ZH012-3)',
      商品ID: '3816812143446196483;3819599849884614828',
      商家编码: 'PT013;ZH012-3',
      商品数量: '2',
      商品金额: '108.90',
      订单应付金额: '58.90',
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      subOrderNo: '6928358141972479308',
      productId: '3816812143446196483',
      merchantCode: 'PT013',
      skuCode: 'PT013',
      quantity: 1,
      itemIndex: 0,
    });
    expect(result.items[1]).toMatchObject({
      subOrderNo: '6928358141972544844',
      productId: '3819599849884614828',
      merchantCode: 'ZH012-3',
      quantity: 1,
      itemIndex: 1,
    });
    for (const item of result.items) {
      expect(item.productAmount).toBeUndefined();
    }
    expect(result.issues).toHaveLength(0);
    expect(result.totalQuantity).toBe(2);
    expect(result.totalProductAmount).toBe('108.90');
  });

  it('多商品行数量合计无法分摊到每行时，数量留空并记录问题', () => {
    const result = normalizer.normalize({
      主订单编号: '6928107630229159882',
      子订单编号: '6928107630229159882;6928107630229159883',
      选购商品: '商品A-(PT013);商品B-(ZH012-3)',
      商品ID: '3816812143446196483;3819599849884614828',
      商家编码: 'PT013;ZH012-3',
      商品数量: '5',
      商品金额: '108.90',
    });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.quantity).toBeUndefined();
      expect(item.productAmount).toBeUndefined();
    }
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].mainOrderNo).toBe('6928107630229159882');
    expect(result.issues[0].message).toContain('无法分摊');
    expect(result.issues[0].detail).toMatchObject({ aligned: true });
  });

  it('多商品行缺少商品数量合计值时，数量留空并记录问题', () => {
    const result = normalizer.normalize({
      主订单编号: '6928107630229159999',
      子订单编号: '6928107630229159999;6928107630229159998',
      选购商品: '商品A-(PT013);商品B-(ZH012-3)',
      商品ID: '3816812143446196483;3819599849884614828',
      商家编码: 'PT013;ZH012-3',
      商品金额: '108.90',
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].quantity).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('缺少商品数量');
  });

  it('多商品字段数量不一致时仍保留记录并标记问题', () => {
    const result = normalizer.normalize({
      主订单编号: '100',
      子订单编号: '100;101',
      选购商品: '商品A',
      商品ID: '1;2',
      商家编码: 'A;B',
      商品数量: '2',
      商品金额: '10.00',
    });

    expect(result.items).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].detail).toMatchObject({ aligned: false });
  });

  it('空值和非法金额不会抛异常', () => {
    const result = normalizer.normalize({
      主订单编号: '200',
      商品金额: '面议',
      订单应付金额: '',
      订单提交时间: 'not-a-date',
    });

    expect(result.items).toHaveLength(1);
    expect(result.payableAmount).toBeUndefined();
    expect(result.totalProductAmount).toBeUndefined();
    expect(result.submittedAt).toBeUndefined();
  });
});
