import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CloseShiftRequestDto,
  CorrectPaymentAmountRequestDto,
  CreateSalaryRequestDto,
  CreateCashboxRequestDto,
  MainCashboxManualRequestDto,
  PaymentBranchToMainRequestDto,
  PaymentFromCourierRequestDto,
  PaymentToMarketRequestDto,
  RecordFinancialBalanceRequestDto,
} from './finance.swagger.dto';
import { CreateInvestmentDto } from './investor.swagger.dto';
import { CreateRemittanceRequestDto } from './integration.swagger.dto';
import { MONEY_MAX, MONEY_MAX_NUMERIC_14_2 } from './money.validators';

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
    error.property === 'balance_cash' ||
    error.property === 'salary_amount'
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

  it('S1: 1e-7 / 5e-7 / "1e-7" / −1e-7 — TypeError (500) emas, 400 xabari', () => {
    for (const bad of [1e-7, 5e-7, '1e-7', -1e-7]) {
      for (const [, cls, base] of amountDtos) {
        expect(() => errorsOf(cls, { ...base, amount: bad })).not.toThrow();
        expect(errorsOf(cls, { ...base, amount: bad }).length).toBeGreaterThan(
          0,
        );
      }
      expect(() =>
        errorsOf(CloseShiftRequestDto, { closing_balance_cash: bad }),
      ).not.toThrow();
      expect(
        errorsOf(CloseShiftRequestDto, { closing_balance_cash: bad }),
      ).not.toEqual([]);
    }
  });

  it('B1/S1: katta aniq tiyinli qiymatlar soxta rad etilmaydi (569244786.94, 4737337519.56, 9999999999999.99)', () => {
    for (const good of [
      569_244_786.94, 4_737_337_519.56, 9_999_999_999_999.99,
    ]) {
      expect(
        errorsOf(PaymentFromCourierRequestDto, {
          courier_id: '5',
          amount: good,
        }),
      ).toEqual([]);
    }
    for (const bad of [0.009, 1.005, 0.1 + 0.2]) {
      expect(
        errorsOf(PaymentFromCourierRequestDto, {
          courier_id: '5',
          amount: bad,
        }),
      ).not.toEqual([]);
    }
  });

  it('nit: noto`g`ri format ("100,5") — faqat «son bo`lishi kerak» (kasr xabari qo`shilmaydi)', () => {
    const messages = errorsOf(PaymentFromCourierRequestDto, {
      courier_id: '5',
      amount: '100,5',
    });
    expect(messages).toContain("amount son bo'lishi kerak");
    expect(messages.join(' ')).not.toContain('kasr');
  });

  it('S2: numeric(14,2) ustunlar — maosh va investitsiya ≤ 999 999 999 999,99', () => {
    expect(MONEY_MAX_NUMERIC_14_2).toBe(999_999_999_999.99);
    const salary = { user_id: '5', salary_amount: 5e12 };
    expect(errorsOf(CreateSalaryRequestDto, salary)).toContain(
      "salary_amount 999 999 999 999,99 so'mdan oshmasligi kerak",
    );
    expect(
      errorsOf(CreateSalaryRequestDto, { ...salary, salary_amount: 5_000_000 }),
    ).toEqual([]);
    expect(errorsOf(CreateInvestmentDto, { amount: 5e12 })).not.toEqual([]);
    expect(errorsOf(CreateInvestmentDto, { amount: 1_000.5 })).toEqual([]);
    // JSON son kutiladi — satr avvalgidek rad etiladi.
    expect(errorsOf(CreateInvestmentDto, { amount: '1000' })).not.toEqual([]);
  });

  it('S3: integratsiya remittance — 2 kasr va chegara (finance.cashbox.fill gacha yetmaydi)', () => {
    expect(errorsOf(CreateRemittanceRequestDto, { amount: 1.005 })).not.toEqual(
      [],
    );
    expect(errorsOf(CreateRemittanceRequestDto, { amount: 1e19 })).not.toEqual(
      [],
    );
    expect(errorsOf(CreateRemittanceRequestDto, { amount: 1_500_000 })).toEqual(
      [],
    );
  });

  it('chegara xabari o`qiladigan formatda', () => {
    expect(
      errorsOf(PaymentFromCourierRequestDto, { courier_id: '5', amount: 1e14 }),
    ).toContain("amount 10 000 000 000 000 so'mdan oshmasligi kerak");
    expect(
      errorsOf(RecordFinancialBalanceRequestDto, { amount: -1e14 }),
    ).toContain("amount −10 000 000 000 000 so'mdan kam bo'lmasligi kerak");
  });
});
