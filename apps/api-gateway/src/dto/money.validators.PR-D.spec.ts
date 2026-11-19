import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CloseShiftRequestDto,
  CorrectPaymentAmountRequestDto,
  CreateCashboxRequestDto,
  MainCashboxManualRequestDto,
  PaymentBranchToMainRequestDto,
  PaymentFromCourierRequestDto,
  PaymentToMarketRequestDto,
  RecordFinancialBalanceRequestDto,
} from './finance.swagger.dto';
import { CreateInvestmentDto } from './investor.swagger.dto';
import { SettlementBranchToHqDto } from './order.swagger.dto';
import { MONEY_MAX } from './money.validators';

/**
 * PR-D (A-5) — pul DTO'lari: ko'pi bilan 2 kasr xonasi va `MONEY_MAX`
 * (1e13) chegarasi. Ilgari `@Min(0.0000001)` — 0,005 so'm olish filialda
 * 100,00 qoldirib MAIN ga +0,01 «yaratardi», 1e19 → 500 (numeric overflow),
 * 9e17 → JS double siljishi.
 */
const errorsOf = (cls: new () => object, body: Record<string, unknown>) =>
  validateSync(plainToInstance(cls, body)).flatMap((error) =>
    error.property === 'amount' ||
    error.property === 'new_amount' ||
    error.property === 'closing_balance_cash' ||
    error.property === 'balance_cash'
      ? Object.values(error.constraints ?? {})
      : [],
  );

describe('PR-D — pul summalari: 2 kasr xonasi va yuqori chegara', () => {
  const amountDtos: Array<[string, new () => object, Record<string, unknown>]> =
    [
      ['payment/courier', PaymentFromCourierRequestDto, { courier_id: '5' }],
      ['payment/market', PaymentToMarketRequestDto, { market_id: '5' }],
      ['branch-to-main', PaymentBranchToMainRequestDto, { branch_id: '5' }],
      ['main spend/fill', MainCashboxManualRequestDto, {}],
    ];

  it.each(amountDtos)(
    '%s: 0,005 / 1e19 / 9e17 / 1e13 + 0,01 / NaN → xato; 0,01, 100,25, "100.5", 1e13 → o`tadi',
    (_name, cls, base) => {
      for (const bad of [0.005, 1e19, 9e17, MONEY_MAX + 0.01, 0, -1, NaN]) {
        expect(errorsOf(cls, { ...base, amount: bad }).length).toBeGreaterThan(
          0,
        );
      }
      for (const good of [0.01, 100.25, '100.5', MONEY_MAX, 0.29]) {
        expect(errorsOf(cls, { ...base, amount: good })).toEqual([]);
      }
    },
  );

  it('T6 summa tuzatish (`new_amount`): 2 kasr va chegara', () => {
    const base = { reason: 'Summa noto`g`ri yozilgan' };
    expect(
      errorsOf(CorrectPaymentAmountRequestDto, { ...base, new_amount: 1e19 }),
    ).not.toEqual([]);
    expect(
      errorsOf(CorrectPaymentAmountRequestDto, {
        ...base,
        new_amount: 450_000,
      }),
    ).toEqual([]);
  });

  it('smena yopish: sanalgan naqd 2 kasr, ≥ 0, ≤ MONEY_MAX', () => {
    for (const bad of [0.001, -1, 1e14]) {
      expect(
        errorsOf(CloseShiftRequestDto, { closing_balance_cash: bad }),
      ).not.toEqual([]);
    }
    expect(
      errorsOf(CloseShiftRequestDto, { closing_balance_cash: 120_000.5 }),
    ).toEqual([]);
  });

  it('ishorali qiymatlar (kassa yaratish, moliyaviy balans): ±MONEY_MAX, 2 kasr', () => {
    expect(
      errorsOf(CreateCashboxRequestDto, {
        user_id: '5',
        cashbox_type: 'branch',
        balance_cash: -500.5,
      }),
    ).toEqual([]);
    expect(
      errorsOf(CreateCashboxRequestDto, {
        user_id: '5',
        cashbox_type: 'branch',
        balance_cash: 1e19,
      }),
    ).not.toEqual([]);
    expect(
      errorsOf(RecordFinancialBalanceRequestDto, { amount: -50_000 }),
    ).toEqual([]);
    expect(
      errorsOf(RecordFinancialBalanceRequestDto, { amount: -1e15 }),
    ).not.toEqual([]);
    expect(
      errorsOf(RecordFinancialBalanceRequestDto, { amount: 10.001 }),
    ).not.toEqual([]);
  });

  it('investitsiya va settlement: JSON son (satr avvalgidek rad etiladi), 2 kasr, chegara', () => {
    expect(errorsOf(CreateInvestmentDto, { amount: 1_000.5 })).toEqual([]);
    expect(errorsOf(CreateInvestmentDto, { amount: '1000' })).not.toEqual([]);
    expect(errorsOf(CreateInvestmentDto, { amount: 1e19 })).not.toEqual([]);
    expect(errorsOf(SettlementBranchToHqDto, { amount: 10 })).toEqual([]);
    expect(errorsOf(SettlementBranchToHqDto, { amount: 9e17 })).not.toEqual([]);
  });
});
