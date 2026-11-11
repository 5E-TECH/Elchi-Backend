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
 * AUDIT M4 (2026-11-11) — menejer orqali yangi to'lov shakllari T6 tuzatishiga
 * TUSHMAYDI: daftarni orqaga surish `branch_to_hq` ni qo'llamaydi
 * (`retreatSettlement`), shuning uchun ular tuzatib / qaytarib bo'lmaydi
 * (`correctable.allowed: false`, `unsupported_type`). HQ (MAIN) shakllari
 * avvalgidek tuzatiladi.
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

describe('M4 — menejer orqali to`lov shakllari tuzatilmaydi', () => {
  const ctm = PaymentMethod.CLICK_TO_MARKET;

  it('«Marketga o`tkazma» filial kassasi orqali (4 oyoq, BRANCH) → null', () => {
    expect(
      classifyTransfer([
        leg('courier', E, CP, ctm),
        leg('branch', I, CP, ctm),
        leg('branch', E, MP, ctm),
        leg('market', E, MP, ctm),
      ]),
    ).toBeNull();
  });

  it('«Marketga to`lov» filial kassasidan (BRANCH EXPENSE + market) → null', () => {
    for (const method of [PaymentMethod.CASH, PaymentMethod.CLICK]) {
      expect(
        classifyTransfer([
          leg('branch', E, MP, method),
          leg('market', E, MP, method),
        ]),
      ).toBeNull();
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
    ).toMatchObject({ kind: 'courier_payment', clickToMarket: true });
    expect(
      classifyTransfer([
        leg('main', E, MP, PaymentMethod.CASH),
        leg('market', E, MP, PaymentMethod.CASH),
      ]),
    ).toMatchObject({ kind: 'market_payment' });
    // Menejerning oddiy naqd qabuli (kuryer → filial) — avvalgidek tuzatiladi.
    expect(
      classifyTransfer([
        leg('courier', E, CP, PaymentMethod.CASH),
        leg('branch', I, CP, PaymentMethod.CASH),
      ]),
    ).toMatchObject({ kind: 'courier_payment', clickToMarket: false });
  });
});
