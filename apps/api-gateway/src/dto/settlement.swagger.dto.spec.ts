import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  SettlementBranchToHqDto,
  SettlementCourierToBranchDto,
  SettlementHqToMarketDto,
} from './order.swagger.dto';
import {
  PaymentBranchToMainRequestDto,
  PaymentFromCourierRequestDto,
  PaymentToMarketRequestDto,
} from './finance.swagger.dto';

// Audit money/API-design P1: the settlement routes accepted an inline-typed
// { *_id, amount } body, so a negative or NaN amount reached order.settlement.*
// unvalidated. These DTOs (validated by the global ValidationPipe) close that.
describe('Settlement amount DTOs', () => {
  const amountErrors = async (dto: object) =>
    (await validate(dto)).filter((e) => e.property === 'amount');

  it('rejects a negative amount', async () => {
    const dto = plainToInstance(SettlementCourierToBranchDto, {
      courier_id: '5',
      amount: -100,
    });
    expect(await amountErrors(dto)).not.toHaveLength(0);
  });

  it('rejects a non-numeric / NaN amount', async () => {
    const dto = plainToInstance(SettlementBranchToHqDto, {
      branch_id: '5',
      amount: 'abc',
    });
    expect(await amountErrors(dto)).not.toHaveLength(0);
  });

  it('rejects more than 2 decimal places', async () => {
    const dto = plainToInstance(SettlementHqToMarketDto, {
      market_id: '5',
      amount: 100.123,
    });
    expect(await amountErrors(dto)).not.toHaveLength(0);
  });

  it.each([
    SettlementCourierToBranchDto,
    SettlementBranchToHqDto,
    SettlementHqToMarketDto,
  ])('qGaxcaD4: %s nol summani rad etadi', async (Dto) => {
    const dto = plainToInstance(Dto, { amount: 0 });
    expect(await amountErrors(dto)).not.toHaveLength(0);
  });

  it('accepts a valid positive 2-dp amount', async () => {
    const dto = plainToInstance(SettlementCourierToBranchDto, {
      courier_id: '5',
      amount: 1000.5,
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});

/**
 * (qGaxcaD4) Eski `/orders/settlement/*` 410 qaytaradi — hozirgi naqd oqimi
 * (kuryer→filial/HQ, filial→HQ, HQ→market) `/finance/cashbox/payment/*`
 * orqali. Ularning DTO'lari ham bo'sh/nol/"100 000" (NaN → JSON null)
 * summani 400 bilan rad etadi — pul harakati boshlanmaydi.
 */
describe('qGaxcaD4 — amaldagi kassa to`lov DTO`lari summani tekshiradi', () => {
  const amountErrors = async (dto: object) =>
    (await validate(dto)).filter((e) => e.property === 'amount');
  const cases = [
    [
      'PaymentFromCourierRequestDto',
      PaymentFromCourierRequestDto,
      { courier_id: '5', payment_method: 'cash' },
    ],
    [
      'PaymentBranchToMainRequestDto',
      PaymentBranchToMainRequestDto,
      { branch_id: '5', payment_method: 'cash' },
    ],
    [
      'PaymentToMarketRequestDto',
      PaymentToMarketRequestDto,
      { market_id: '5', payment_method: 'cash' },
    ],
  ] as const;

  describe.each(cases)('%s', (_name, Dto, base) => {
    it.each([
      ['nol', 0],
      ['null (NaN JSON da)', null],
      ['bo`sh satr', ''],
      ['probelli "100 000"', '100 000'],
      ['manfiy', -100],
    ])('%s summa rad etiladi', async (_label, amount) => {
      const dto = plainToInstance(Dto, { ...base, amount });
      expect(await amountErrors(dto)).not.toHaveLength(0);
    });

    it('musbat summa o`tadi', async () => {
      const dto = plainToInstance(Dto, { ...base, amount: 100000 });
      expect(await amountErrors(dto)).toHaveLength(0);
    });
  });
});
