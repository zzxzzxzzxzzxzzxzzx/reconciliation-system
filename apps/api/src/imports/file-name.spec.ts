import { normalizeOriginalFileName } from './file-name';

describe('normalizeOriginalFileName', () => {
  it('keeps an already-correct Chinese filename unchanged', () => {
    const name = '小象汉字APP账单结算_抖音商品成本表.xlsx';
    expect(normalizeOriginalFileName(name)).toBe(name);
  });

  it('repairs a UTF-8 filename decoded as Latin1', () => {
    expect(normalizeOriginalFileName('XQH-å°è±¡æ±å­å¾ä¹¦æè°åº.xlsx'))
      .toBe('XQH-小象汉字图书旗舰店.xlsx');
  });

  it('keeps an ASCII filename unchanged', () => {
    expect(normalizeOriginalFileName('orders-2026-07.csv')).toBe('orders-2026-07.csv');
  });
});
