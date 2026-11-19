import { BadRequestException } from '@nestjs/common';
import { FinanceServiceService } from './finance-service.service';

/**
 * PR-D (A-5) — finance `assertPositiveAmount` (to'lov, sotuv, maosh yo'llari):
 * RPC orqali gateway'siz kelgan summa ham ≤ 2 kasr va ≤ MONEY_MAX bo'lsin.
 */
describe('PR-D — finance assertPositiveAmount', () => {
  const service = Object.create(FinanceServiceService.prototype) as unknown as {
    assertPositiveAmount: (value: number, field?: string) => void;
  };
  const check = (value: number) => () => service.assertPositiveAmount(value);

  it('rad etadi: 0, manfiy, NaN, ∞, 0,005, 100,001, 1e19, 9e17, MONEY_MAX + 0,01', () => {
    for (const bad of [
      0,
      -1,
      NaN,
      Infinity,
      0.005,
      100.001,
      1e19,
      9e17,
      FinanceServiceService.MONEY_MAX + 0.01,
    ]) {
      expect(check(bad)).toThrow(BadRequestException);
    }
  });

  it('o`tkazadi: 0,01, 0,29 (double 28,999…), 0,1 + 0,2, 100,25, MONEY_MAX', () => {
    for (const good of [
      0.01,
      0.29,
      0.1 + 0.2,
      100.25,
      1_234_567.89,
      FinanceServiceService.MONEY_MAX,
    ]) {
      expect(check(good)).not.toThrow();
    }
  });

  it('xato matni maydon nomi bilan', () => {
    expect(() => service.assertPositiveAmount(0.005, 'salary_amount')).toThrow(
      "salary_amount — ko'pi bilan 2 xonali kasr (tiyin) bo'lishi kerak",
    );
  });
  it('B1: katta aniq qiymatlar va HISOBLANGAN oyoqlar soxta rad etilmaydi (outbox cheksiz qayta urinmasin)', () => {
    for (const good of [
      569_244_786.94, 4_737_337_519.56, 9_999_999_999_999.99,
    ]) {
      expect(check(good)).not.toThrow();
    }
    // order-service sotuv oyog'i: collectible − marketTariff − share (numeric(14,2)).
    const leg = 98_765_432_109.87 - 1_234_567.89 - 45_678.12;
    expect(check(leg)).not.toThrow();
    let rejected = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const a = Number((((i * 7_919) % 99_991) * 1_000_003.37).toFixed(2));
      const b = Number((((i * 104_729) % 9_973) * 101.11).toFixed(2));
      const c = Number(((i % 997) * 13.07).toFixed(2));
      const value = a - b - c;
      if (value <= 0) continue;
      try {
        service.assertPositiveAmount(value);
      } catch {
        rejected += 1;
      }
    }
    expect(rejected).toBe(0);
    // Haqiqiy kasr xatolari hali rad.
    for (const bad of [0.005, 1.005, 0.009, 1e8 + 0.005]) {
      expect(check(bad)).toThrow(BadRequestException);
    }
  });
});
