import { Order_status } from '../../enums';
import {
  CANONICAL_PAYMENT_STATUSES,
  CANONICAL_SHIPMENT_STATUSES,
  INBOUND_DEFAULT_ACTION,
  STATUS_CATALOG,
  toStatusKey,
} from './status-catalog';

/**
 * Katalog va ichki status enumi BIR manbadan (JnHK6bgV): katalogdagi har kod
 * enumda bor, enumdagi har qiymat katalogda bor — qo'lda yozilgan ro'yxat
 * bo'lsa vaqt o'tib ajralardi va xarita jimgina ishlamay qolardi.
 */
describe('status katalogi', () => {
  const enumValues = Object.values(Order_status) as string[];

  it('⭐ katalogdagi har posilka kodi Order_status enumida bor', () => {
    for (const entry of CANONICAL_SHIPMENT_STATUSES) {
      expect(enumValues).toContain(entry.code);
    }
  });

  it('⭐ enumdagi har qiymat katalogda bor (yangi status izohsiz qolmaydi)', () => {
    expect(CANONICAL_SHIPMENT_STATUSES.map((e) => e.code)).toEqual(enumValues);
  });

  it('har yozuvda o‘zbekcha izoh bor', () => {
    for (const entry of [
      ...CANONICAL_SHIPMENT_STATUSES,
      ...CANONICAL_PAYMENT_STATUSES,
    ]) {
      expect(entry.meaning_uz.trim().length).toBeGreaterThan(3);
    }
  });

  it('probel/qavsli kodlar uchun xavfsiz kalit, kod esa o‘zgarmaydi', () => {
    const onTheRoad = CANONICAL_SHIPMENT_STATUSES.find(
      (e) => e.code === 'on the road',
    );
    const cancelledSent = CANONICAL_SHIPMENT_STATUSES.find(
      (e) => e.code === 'cancelled (sent)',
    );
    expect(onTheRoad?.key).toBe('on_the_road');
    expect(cancelledSent?.key).toBe('cancelled_sent');
    expect(toStatusKey('Returned To-Market')).toBe('returned_to_market');
    const keys = CANONICAL_SHIPMENT_STATUSES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('to‘lov xaritasi alohida (kichik) katalog oladi', () => {
    expect(STATUS_CATALOG.payment.map((e) => e.code)).toEqual([
      'succeeded',
      'pending',
      'failed',
      'refunded',
    ]);
    expect(STATUS_CATALOG.payment.map((e) => e.code)).not.toContain('sold');
  });

  it('sukut action faqat yakuniy holatlarda va backend qabul qiladigan qiymatlar', () => {
    for (const [status, action] of Object.entries(INBOUND_DEFAULT_ACTION)) {
      expect(enumValues).toContain(status);
      expect(['sell', 'cancel', 'return']).toContain(action);
    }
  });
});
