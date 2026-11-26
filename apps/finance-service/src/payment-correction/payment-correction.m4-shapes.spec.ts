import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import {
  classifyTransfer,
  type HistoryWithCashbox,
} from './payment-correction.rules';

/**
 * AUDIT M4 (2026-11-11) menejer orqali to'lov shakllari. (2026-11-26, ega)
 * Endi FAQAT QAYTARILADI (`reverseOnly`): A — «Marketga o'tkazma» filial
 * kassasi orqali (`courier_click_branch`), B — filial kassasidan marketga
 * (`market_branch`). Daftar orqaga: A — `hq_to_market` → `branch_to_hq` →
 * `courier_to_branch`; B — `branch_to_market`. HQ (MAIN) shakllari
 * avvalgidek tuzatiladi (tahrir ham).
 */

const boxes = {
  courier: { id: '1', user_id: '209', cashbox_type: Cashbox_type.FOR_COURIER },
  branch: { id: '2', user_id: '15', cashbox_type: Cashbox_type.BRANCH },
  main: { id: '3', user_id: '0', cashbox_type: Cashbox_type.MAIN },
  market: { id: '4', user_id: '201', cashbox_type: Cashbox_type.FOR_MARKET },
};

const leg = (
  box: keyof typeof boxes,
  operation_type: Operation_type,
  source_type: Source_type,
  payment_method: PaymentMethod,
): HistoryWithCashbox =>
  ({
    cashbox_id: boxes[box].id,
    cashbox: boxes[box],
    operation_type,
    source_type,
    payment_method,
    amount: 300_000,
    transfer_id: 't-1',
  }) as unknown as HistoryWithCashbox;

const E = Operation_type.EXPENSE;
const I = Operation_type.INCOME;
const CP = Source_type.COURIER_PAYMENT;
const MP = Source_type.MARKET_PAYMENT;

describe('M4 — menejer orqali to`lov shakllari faqat qaytariladi', () => {
  const ctm = PaymentMethod.CLICK_TO_MARKET;

  it('⭐ A: «Marketga o`tkazma» filial kassasi orqali (4 oyoq, BRANCH) → `courier_click_branch`', () => {
    const shape = classifyTransfer([
      leg('courier', E, CP, ctm),
      leg('branch', I, CP, ctm),
      leg('branch', E, MP, ctm),
      leg('market', E, MP, ctm),
    ]);
    expect(shape).toMatchObject({
      kind: 'courier_payment',
      variant: 'courier_click_branch',
      clickToMarket: true,
      reverseOnly: true,
      counterpartyUserId: '209',
    });
    expect(shape?.receiverCashbox).toBe(boxes.branch);
    expect(shape?.mainMarketLeg?.cashbox).toBe(boxes.branch);
  });

  it('A: filialning ikki oyog`i boshqa-boshqa kassada → null', () => {
    const otherBranch = {
      ...leg('branch', E, MP, ctm),
      cashbox_id: '7',
      cashbox: { ...boxes.branch, id: '7' },
    } as unknown as HistoryWithCashbox;
    expect(
      classifyTransfer([
        leg('courier', E, CP, ctm),
        leg('branch', I, CP, ctm),
        otherBranch,
        leg('market', E, MP, ctm),
      ]),
    ).toBeNull();
  });

  it('⭐ B: «Marketga to`lov» filial kassasidan (BRANCH EXPENSE + market) → `market_branch`', () => {
    for (const method of [PaymentMethod.CASH, PaymentMethod.CLICK]) {
      const shape = classifyTransfer([
        leg('branch', E, MP, method),
        leg('market', E, MP, method),
      ]);
      expect(shape).toMatchObject({
        kind: 'market_payment',
        variant: 'market_branch',
        reverseOnly: true,
        counterpartyUserId: '201',
      });
      expect(shape?.receiverCashbox).toBe(boxes.branch);
    }
  });

  it('HQ shakllari avvalgidek tuzatiladi', () => {
    expect(
      classifyTransfer([
        leg('courier', E, CP, ctm),
        leg('main', I, CP, ctm),
        leg('main', E, MP, ctm),
        leg('market', E, MP, ctm),
      ]),
    ).toMatchObject({
      kind: 'courier_payment',
      variant: 'courier_click',
      clickToMarket: true,
      reverseOnly: false,
    });
    expect(
      classifyTransfer([
        leg('main', E, MP, PaymentMethod.CASH),
        leg('market', E, MP, PaymentMethod.CASH),
      ]),
    ).toMatchObject({
      kind: 'market_payment',
      variant: 'market',
      reverseOnly: false,
    });
    // Menejerning oddiy naqd qabuli (kuryer → filial) — avvalgidek tuzatiladi.
    expect(
      classifyTransfer([
        leg('courier', E, CP, PaymentMethod.CASH),
        leg('branch', I, CP, PaymentMethod.CASH),
      ]),
    ).toMatchObject({
      kind: 'courier_payment',
      variant: 'courier',
      clickToMarket: false,
      reverseOnly: false,
    });
  });
});
