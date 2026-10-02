/// <reference types="jest" />
import { OrderServiceService } from './order-service.service';

/**
 * Mijozga ko'rinadigan buyurtma raqami (chek + QR yorlig'i): "EL-" + (id +
 * 100000). Ilgari yorliqda xom tartib raqam (#81) chiqardi; endi #EL-100081.
 * id'dan hosil qilinadi — migration shart emas, deterministik, noyob.
 */
describe('OrderServiceService.formatOrderNumber', () => {
  const svc: any = Object.create(OrderServiceService.prototype);

  it('id -> "EL-" + (id + 100000)', () => {
    expect(svc.formatOrderNumber(81)).toBe('EL-100081');
    expect(svc.formatOrderNumber('81')).toBe('EL-100081'); // satr ham
    expect(svc.formatOrderNumber(1)).toBe('EL-100001');
    expect(svc.formatOrderNumber(999999)).toBe('EL-1099999');
  });

  it('noto`g`ri/bo`sh id -> bo`sh satr (yorliqda raqam ko`rsatilmaydi)', () => {
    expect(svc.formatOrderNumber(null)).toBe('');
    expect(svc.formatOrderNumber(undefined)).toBe('');
    expect(svc.formatOrderNumber(0)).toBe('');
    expect(svc.formatOrderNumber(-5)).toBe('');
    expect(svc.formatOrderNumber('abc')).toBe('');
  });

  it('har doim 6+ xonali (100000 dan katta) — "#1" muammosi yo`q', () => {
    for (const id of [1, 5, 42, 500, 12345]) {
      const on = svc.formatOrderNumber(id);
      const num = Number(on.replace('EL-', ''));
      expect(num).toBeGreaterThanOrEqual(100001);
      expect(String(num).length).toBeGreaterThanOrEqual(6);
    }
  });
});
