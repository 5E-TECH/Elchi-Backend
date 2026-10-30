import {
  CASHBOX_RECEIPT_ERROR_CODES,
  CASHBOX_RECEIPT_MESSAGES,
  applyReceiptSettingsPatch,
  receiptSettingGroupOf,
  type CashboxReceiptSettings,
} from './cashbox-receipt';
import { PUBLIC_ERROR_CODES } from '../filters/public-error-fields';

/** T3 (QlLf33Ma) — chek sozlamasi qoidasi va kodlar. */
describe('applyReceiptSettingsPatch', () => {
  const all = (photo: boolean, ai: boolean): CashboxReceiptSettings => ({
    manual_expense: { photo_required: photo, ai_enabled: ai },
    hq_transfer: { photo_required: photo, ai_enabled: ai },
  });

  it('faqat photo_required:false → AI ham false; boshqa guruh tegilmaydi', () => {
    expect(
      applyReceiptSettingsPatch(all(true, true), {
        manual_expense: { photo_required: false },
      }),
    ).toEqual({
      ok: true,
      value: {
        manual_expense: { photo_required: false, ai_enabled: false },
        hq_transfer: { photo_required: true, ai_enabled: true },
      },
    });
  });

  it('rasm qayta yoqilsa AI o`chiq qoladi', () => {
    expect(
      applyReceiptSettingsPatch(all(false, false), {
        hq_transfer: { photo_required: true },
      }),
    ).toMatchObject({
      ok: true,
      value: { hq_transfer: { photo_required: true, ai_enabled: false } },
    });
  });

  it.each([
    [
      all(true, true),
      { manual_expense: { photo_required: false, ai_enabled: true } },
    ],
    [all(false, false), { manual_expense: { ai_enabled: true } }],
  ])('AI yoqiq + rasm o`chiq → RECEIPT_AI_REQUIRES_PHOTO', (current, patch) => {
    expect(applyReceiptSettingsPatch(current, patch)).toEqual({
      ok: false,
      code: 'RECEIPT_AI_REQUIRES_PHOTO',
      group: 'manual_expense',
    });
  });

  it('tur → guruh', () => {
    expect(receiptSettingGroupOf('manual_expense')).toBe('manual_expense');
    expect(receiptSettingGroupOf('courier_to_hq')).toBe('hq_transfer');
    expect(receiptSettingGroupOf('branch_to_hq')).toBe('hq_transfer');
  });

  it('har kodning matni bor va PUBLIC_ERROR_CODES da (FE kodni ko`radi)', () => {
    for (const code of Object.values(CASHBOX_RECEIPT_ERROR_CODES)) {
      expect(CASHBOX_RECEIPT_MESSAGES[code]).toBeTruthy();
      expect(PUBLIC_ERROR_CODES).toHaveProperty(code);
    }
  });
});
