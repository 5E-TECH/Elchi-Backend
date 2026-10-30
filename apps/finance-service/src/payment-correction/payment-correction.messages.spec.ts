import { TELEGRAM_DM_DELIVERY_TYPES, findNotificationType } from '@app/common';
import {
  buildPaymentCorrectedPayload,
  normalizeCorrectionLanguage,
} from '../notification/finance-notification.service';
import { buildPaymentCorrectedMessage } from '../realtime/finance-realtime.service';

/** T6-BE-4 — `finance.payment_corrected` matnlari va realtime nishonlari. */
describe('T6 finance.payment_corrected', () => {
  const base = {
    correction_id: '12',
    recipient_id: '301',
    payment_id: '845',
    amount: 500_000,
    payment_date: '2026-10-20T07:00:00.000Z',
  };

  it('katalog: FINANCE, HIGH, o`chirib bo`lmaydi, in_app+realtime+telegram, faqat DM', () => {
    const entry = findNotificationType('finance.payment_corrected');
    expect(entry).toMatchObject({
      category: 'finance',
      priority: 'high',
      user_can_mute: false,
    });
    expect(entry?.default_channels).toEqual(['in_app', 'realtime', 'telegram']);
    expect(TELEGRAM_DM_DELIVERY_TYPES).toContain('finance.payment_corrected');
  });

  it('⭐ qaytarish — uz / ru / en, qoldiq oldin → keyin, sabab yo`q', () => {
    const input = {
      ...base,
      action: 'reverse' as const,
      balance_before: 0,
      balance_after: 500_000,
    };
    const uz = buildPaymentCorrectedPayload({ ...input, language: 'uz' });
    expect(uz).toMatchObject({
      type: 'finance.payment_corrected',
      title: "To'lov qaytarildi",
      body: "20.10.2026 dagi 500 000 so'm to'lov (#845) qaytarildi. Qoldiq: 0 so'm → 500 000 so'm.",
      link: '/cash-box',
      recipient_ids: ['301'],
      group_key: 'finance:payment_correction:12',
    });
    expect(
      buildPaymentCorrectedPayload({ ...input, language: 'ru' }),
    ).toMatchObject({
      title: 'Платёж отменён',
      body: 'Платёж #845 от 20.10.2026 на 500 000 сум отменён. Остаток: 0 сум → 500 000 сум.',
    });
    expect(
      buildPaymentCorrectedPayload({ ...input, language: 'en' }),
    ).toMatchObject({
      title: 'Payment reversed',
      body: 'Payment #845 of 500 000 UZS on 20.10.2026 was reversed. Balance: 0 UZS → 500 000 UZS.',
    });
    // Har oluvchiga barqaror dispatch id.
    expect(uz?.client_request_id).toBe(
      buildPaymentCorrectedPayload({ ...input, language: 'uz' })
        ?.client_request_id,
    );
  });

  it('tahrir — eski → yangi; noma`lum til → uz; yaroqsiz oluvchi → null', () => {
    const edit = { ...base, action: 'edit' as const, new_amount: 50_000 };
    expect(
      buildPaymentCorrectedPayload({ ...edit, language: 'en-US' }),
    ).toMatchObject({
      title: 'Payment amount corrected',
      body: 'Payment #845: 500 000 UZS → 50 000 UZS.',
    });
    expect(
      buildPaymentCorrectedPayload({ ...edit, language: 'kk' })?.body,
    ).toBe("To'lov #845: 500 000 so'm → 50 000 so'm.");
    expect(normalizeCorrectionLanguage(null)).toBe('uz');
    expect(
      buildPaymentCorrectedPayload({ ...edit, recipient_id: '0' }),
    ).toBeNull();
  });

  it('realtime: MAIN — superadmin/admin/registrator; BRANCH — filial menejerlari; summasiz', () => {
    const main = buildPaymentCorrectedMessage({
      correction_id: '12',
      action: 'reverse',
      payment_kind: 'courier_payment',
      receiver_cashbox_type: 'main',
      user_ids: ['301', null],
      cashbox_ids: ['1', '7'],
    });
    expect(main.event).toBe('finance.payment.corrected');
    expect(main.targets).toEqual([
      { role: 'superadmin' },
      { role: 'admin' },
      { role: 'registrator' },
      { user_id: '301' },
    ]);
    const branch = buildPaymentCorrectedMessage({
      correction_id: '13',
      action: 'edit',
      payment_kind: 'courier_payment',
      receiver_cashbox_type: 'branch',
      branch_id: '15',
      user_ids: ['301'],
      cashbox_ids: ['9'],
    });
    expect(branch.targets).toEqual([
      { role: 'manager', branch_id: '15' },
      { user_id: '301' },
    ]);
    expect(branch.payload).toMatchObject({
      cashbox_type: 'branch',
      branch_id: '15',
    });
    expect(Object.keys(branch.payload)).not.toContain('amount');
  });
});
