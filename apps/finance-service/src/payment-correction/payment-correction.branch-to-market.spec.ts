import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import {
  classifyTransfer,
  isCorrectableType,
  type HistoryWithCashbox,
} from './payment-correction.rules';

/**
 * (2026-11-11) «Marketga o'tkazma» FILIALDAN (`paymentFromBranchToMarket`):
 * filial EXPENSE + MAIN INCOME (`branch_to_main`) + MAIN EXPENSE + market
 * EXPENSE (`market_payment`), hammasi `click_to_market`, bitta
 * `transfer_id`. T6 tuzatish bu shaklni QO'LLAMAYDI (daftarni orqaga surish
 * `branch_to_hq` ni bilmaydi) — `classifyTransfer` → null →
 * `NOT_CORRECTABLE` / `unsupported_type`. Haqiqiy Postgres bilan:
 * `finance-branch-to-market.pg.spec.ts`.
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

describe('Filialdan marketga o`tkazma — T6 tuzatishiga tushmaydi', () => {
  const E = Operation_type.EXPENSE;
  const I = Operation_type.INCOME;
  const B2M = Source_type.BRANCH_TO_MAIN;
  const MP = Source_type.MARKET_PAYMENT;

  it('to`rt oyoq (filial → MAIN → market) → null', () => {
    expect(
      classifyTransfer([
        leg('branch', E, B2M),
        leg('main', I, B2M),
        leg('main', E, MP),
        leg('market', E, MP),
      ]),
    ).toBeNull();
  });

  it('market oyoqlari alohida olinsa ham (click_to_market, 2 oyoq) → null', () => {
    expect(
      classifyTransfer([leg('main', E, MP), leg('market', E, MP)]),
    ).toBeNull();
  });

  it('`branch_to_main` turi umuman qamrovda emas', () => {
    expect(isCorrectableType(B2M)).toBe(false);
  });
});
