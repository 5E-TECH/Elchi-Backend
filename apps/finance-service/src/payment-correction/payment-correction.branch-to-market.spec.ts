import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import {
  classifyTransfer,
  isBranchTransferType,
  isCorrectableType,
  type HistoryWithCashbox,
} from './payment-correction.rules';

/**
 * (2026-11-11) «Marketga o'tkazma» FILIALDAN (`paymentFromBranchToMarket`):
 * filial EXPENSE + MAIN INCOME (`branch_to_main`) + MAIN EXPENSE + market
 * EXPENSE (`market_payment`), hammasi `click_to_market`, bitta
 * `transfer_id`. (2026-11-26, ega) T6 bu shaklni FAQAT QAYTARADI
 * (`branch_click_market`, `reverseOnly`) — daftar `hq_to_market` →
 * `branch_to_hq` orqaga. Haqiqiy Postgres bilan:
 * `payment-correction.branch-shapes.pg.spec.ts`.
 */
const boxes = {
  branch: { id: '2', user_id: '15', cashbox_type: Cashbox_type.BRANCH },
  main: { id: '3', user_id: '0', cashbox_type: Cashbox_type.MAIN },
  market: { id: '4', user_id: '201', cashbox_type: Cashbox_type.FOR_MARKET },
};

const leg = (
  box: keyof typeof boxes,
  operation_type: Operation_type,
  source_type: Source_type,
): HistoryWithCashbox =>
  ({
    cashbox_id: boxes[box].id,
    cashbox: boxes[box],
    operation_type,
    source_type,
    payment_method: PaymentMethod.CLICK_TO_MARKET,
    amount: 250_000,
    transfer_id: 't-b2m',
  }) as unknown as HistoryWithCashbox;

describe('Filialdan marketga o`tkazma (C) — faqat qaytariladi', () => {
  const E = Operation_type.EXPENSE;
  const I = Operation_type.INCOME;
  const B2M = Source_type.BRANCH_TO_MAIN;
  const MP = Source_type.MARKET_PAYMENT;

  it('⭐ to`rt oyoq (filial → MAIN → market) → `branch_click_market`, pul filialga qaytadi', () => {
    const shape = classifyTransfer([
      leg('branch', E, B2M),
      leg('main', I, B2M),
      leg('main', E, MP),
      leg('market', E, MP),
    ]);
    expect(shape).toMatchObject({
      kind: 'market_payment',
      variant: 'branch_click_market',
      clickToMarket: true,
      reverseOnly: true,
      amount: 250_000,
      counterpartyUserId: '201',
    });
    expect(shape?.receiverCashbox).toBe(boxes.branch);
    expect(shape?.branchLeg?.cashbox).toBe(boxes.branch);
    expect(shape?.mainIncomeLeg?.cashbox).toBe(boxes.main);
    expect(shape?.mainMarketLeg?.cashbox).toBe(boxes.main);
  });

  it('buzilgan C guruhi (oyoq yetmaydi / ortiqcha / boshqa usul / MAIN oyoqlari boshqa kassada) → null', () => {
    const full = [
      leg('branch', E, B2M),
      leg('main', I, B2M),
      leg('main', E, MP),
      leg('market', E, MP),
    ];
    expect(classifyTransfer(full.slice(0, 3))).toBeNull();
    expect(classifyTransfer([...full, leg('main', E, MP)])).toBeNull();
    expect(
      classifyTransfer(
        full.map((item) => ({ ...item, payment_method: PaymentMethod.CLICK })),
      ),
    ).toBeNull();
    const otherMain = {
      ...full[1],
      cashbox_id: '9',
      cashbox: { ...boxes.main, id: '9' },
    } as unknown as HistoryWithCashbox;
    expect(classifyTransfer([full[0], otherMain, full[2], full[3]])).toBeNull();
  });

  it('oddiy filial → HQ topshirig`i (2 oyoq `branch_to_main`) — qamrovda emas', () => {
    expect(
      classifyTransfer(
        [leg('branch', E, B2M), leg('main', I, B2M)].map((item) => ({
          ...item,
          payment_method: PaymentMethod.CASH,
        })),
      ),
    ).toBeNull();
  });

  it('market oyoqlari alohida olinsa ham (click_to_market, 2 oyoq) → null', () => {
    expect(
      classifyTransfer([leg('main', E, MP), leg('market', E, MP)]),
    ).toBeNull();
  });

  it('`branch_to_main` — to`lov turi emas, faqat C shaklida (alohida tekshiruv)', () => {
    expect(isCorrectableType(B2M)).toBe(false);
    expect(isBranchTransferType(B2M)).toBe(true);
    expect(isBranchTransferType(MP)).toBe(false);
  });
});
