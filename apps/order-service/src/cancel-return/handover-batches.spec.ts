import {
  formatHandoverBatchId,
  parseHandoverBatchId,
  resolveHandoverBatchMethod,
  toHandoverBatchView,
} from './handover-batches';

/** «Topshirilgan» partiya kaliti va karta ko'rinishi (2026-11-10). */
describe('handover-batches', () => {
  it('kalit: format ↔ parse (xodimsiz — 0)', () => {
    const key = {
      market_id: '121',
      handed_at_us: '1762774920123456',
      handed_by: '520',
    };
    expect(formatHandoverBatchId(key)).toBe('121_1762774920123456_520');
    expect(parseHandoverBatchId('121_1762774920123456_520')).toEqual(key);
    expect(parseHandoverBatchId(' 121_1762774920123456_0 ')).toEqual({
      ...key,
      handed_by: null,
    });
  });

  it.each([
    undefined,
    '',
    '121_1762774920123456',
    '121_abc_520',
    '0_1762774920123456_520',
    '121_0_520',
    "121_1_520' OR 1=1",
    '1_2_3_4',
  ])('buzuq kalit — null: %p', (raw) => {
    expect(parseHandoverBatchId(raw)).toBeNull();
  });

  it('asosiy usul: qo‘lda bo‘lmagani; hammasi qo‘lda — manual; noma’lum — null', () => {
    expect(resolveHandoverBatchMethod('pin', 1, 3)).toBe('pin');
    expect(resolveHandoverBatchMethod('qr', 0, 2)).toBe('qr');
    expect(resolveHandoverBatchMethod('no_qr', 0, 1)).toBe('no_qr');
    expect(resolveHandoverBatchMethod(null, 2, 2)).toBe('manual');
    expect(resolveHandoverBatchMethod(null, 0, 2)).toBeNull();
    expect(resolveHandoverBatchMethod('boshqa', 0, 2)).toBeNull();
  });

  it('karta: sonlar, ms vaqt, market va xodim', () => {
    expect(
      toHandoverBatchView(
        {
          market_id: '121',
          handed_at_us: '1762774920123456',
          handed_by: '520',
          day: '2026-11-10',
          orders_count: '3',
          total_price_sum: '761000.00',
          manual_count: '1',
          method: 'qr',
        },
        { id: 121, name: 'Baraka Shop', phone_number: '+998901234567' },
        'Aziz Karimov',
      ),
    ).toEqual({
      id: '121_1762774920123456_520',
      market_id: '121',
      market: {
        id: '121',
        name: 'Baraka Shop',
        phone_number: '+998901234567',
      },
      handed_at: '2025-11-10T11:42:00.123Z',
      day: '2026-11-10',
      handed_by: { id: '520', name: 'Aziz Karimov' },
      method: 'qr',
      manual_count: 1,
      orders_count: 3,
      total_price_sum: 761000,
    });
  });

  it('karta: market topilmasa — null, xodimsiz — null', () => {
    const view = toHandoverBatchView(
      {
        market_id: '9',
        handed_at_us: '1000',
        handed_by: null,
        day: '1970-01-01',
        orders_count: 1,
        total_price_sum: 0,
        manual_count: 0,
        method: null,
      },
      null,
      undefined,
    );
    expect(view.market).toBeNull();
    expect(view.handed_by).toBeNull();
    expect(view.id).toBe('9_1000_0');
  });
});
