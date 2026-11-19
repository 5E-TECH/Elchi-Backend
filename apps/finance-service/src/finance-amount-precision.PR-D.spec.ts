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
});
