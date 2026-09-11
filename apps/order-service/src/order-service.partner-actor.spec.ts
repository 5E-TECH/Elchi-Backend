import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

/**
 * HAMKOR AKTYORI — `last_handover_by` bigint ustuniga sun'iy id yozilmasin.
 *
 * REAL XATO (2026-09-11, birinchi jonli posilkada topildi). Hamkor (Partner
 * API) oqimida buyurtma `requester = { id: 'partner:1', roles: [superadmin] }`
 * bilan yaratiladi — ortida haqiqiy foydalanuvchi yo'q. `last_handover_by`
 * esa `bigint`. Natijada Postgres `22P02` berardi va BUTUN tranzaksiya
 * qaytardi; tashqariga esa "ID qiymatlari raqam ko'rinishida bo'lishi kerak"
 * degan umumiy xato chiqib, qaysi maydon aybdor ekani ko'rinmasdi.
 *
 * Oqibati: hamkordan kelgan HECH BIR posilka yaratilmasdi.
 */
describe('OrderLifecycleService — aktyor id raqamli bo\'lishi', () => {
  const svc: any = Object.create(OrderLifecycleService.prototype);
  const pick = (v: unknown) => svc.numericActorId(v);

  it('haqiqiy foydalanuvchi id saqlanadi', () => {
    expect(pick('135')).toBe('135');
    expect(pick(135)).toBe('135');
  });

  it("hamkorning sun'iy id'si NULL ga aylanadi (bigint xatosining oldini oladi)", () => {
    expect(pick('partner:1')).toBeNull();
    expect(pick('partner:42')).toBeNull();
  });

  it("bo'sh va noaniq qiymatlar NULL", () => {
    expect(pick(null)).toBeNull();
    expect(pick(undefined)).toBeNull();
    expect(pick('')).toBeNull();
    expect(pick('   ')).toBeNull();
    expect(pick('system')).toBeNull();
  });

  it('aralash satr RAD ETILADI — qisman raqam yetarli emas', () => {
    // '12abc' dan '12' ni ajratib olish jimgina NOTO'G'RI odamga bog'lardi.
    expect(pick('12abc')).toBeNull();
    expect(pick('abc12')).toBeNull();
    expect(pick('1.5')).toBeNull();
    expect(pick('-5')).toBeNull();
  });

  it('atrofdagi bo\'shliq tozalanadi', () => {
    expect(pick('  77  ')).toBe('77');
  });
});
