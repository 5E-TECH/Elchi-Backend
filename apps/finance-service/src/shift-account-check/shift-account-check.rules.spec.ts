import {
  defaultCardShiftFlags,
  deriveAiStatus,
  deriveEnteredOk,
  effectiveShiftCheckSettings,
  isAiEnabled,
  isCommentRequired,
  isPhotoRequired,
  SHIFT_CHECK_DEFAULTS,
  SHIFT_SETTING_KEYS,
} from './shift-account-check.rules';

/** kiZgTybn — AI holati va izoh majburiyligi qoidalari. */
describe('shift-account-check rules (kiZgTybn)', () => {
  const base = {
    ok: true,
    read_balance: 100_000,
    last4_detected: '1234',
    confidence: 0.9,
    expected_balance: 100_000,
    card_last4: '1234',
  };

  it('match: |farq| ≤ 1 so‘m va last4 mos', () => {
    expect(deriveAiStatus(base)).toBe('match');
    expect(deriveAiStatus({ ...base, read_balance: 100_001 })).toBe('match');
    expect(
      deriveAiStatus({ ...base, card_last4: null, last4_detected: null }),
    ).toBe('match');
  });

  it('mismatch: summa farqi > 1 yoki last4 boshqa / o‘qilmagan', () => {
    expect(deriveAiStatus({ ...base, read_balance: 100_002 })).toBe('mismatch');
    expect(deriveAiStatus({ ...base, last4_detected: '9999' })).toBe(
      'mismatch',
    );
    expect(deriveAiStatus({ ...base, last4_detected: null })).toBe('mismatch');
  });

  it('unreadable / error', () => {
    expect(deriveAiStatus({ ...base, read_balance: null })).toBe('unreadable');
    expect(deriveAiStatus({ ...base, confidence: 0.2 })).toBe('unreadable');
    expect(deriveAiStatus({ ...base, ok: false, reason: 'refused' })).toBe(
      'unreadable',
    );
    expect(deriveAiStatus({ ...base, ok: false, reason: 'network' })).toBe(
      'error',
    );
    expect(deriveAiStatus({ ...base, ok: false, reason: 'cap_exceeded' })).toBe(
      'error',
    );
  });

  it('ai_entered_ok va izoh majburiyligi', () => {
    expect(deriveEnteredOk(100_000, 100_000.5)).toBe(true);
    expect(deriveEnteredOk(90_000, 100_000)).toBe(false);
    expect(deriveEnteredOk(null, 100_000)).toBeNull();
    expect(
      isCommentRequired({
        difference: 0,
        ai_status: 'match',
        ai_entered_ok: true,
      }),
    ).toBe(false);
    expect(
      isCommentRequired({
        difference: -1,
        ai_status: 'match',
        ai_entered_ok: true,
      }),
    ).toBe(true);
    expect(
      isCommentRequired({
        difference: 0,
        ai_status: 'mismatch',
        ai_entered_ok: null,
      }),
    ).toBe(true);
    expect(
      isCommentRequired({
        difference: 0,
        ai_status: 'error',
        ai_entered_ok: false,
      }),
    ).toBe(true);
  });

  it('global master kalitlar × karta bayroqlari (BE-A sukut: rasm va AI yoqiq)', () => {
    const card = { require_photo_on_shift_close: true, ai_check_enabled: true };
    expect(isPhotoRequired(SHIFT_CHECK_DEFAULTS, card)).toBe(true);
    expect(isAiEnabled(SHIFT_CHECK_DEFAULTS, card)).toBe(true);
    expect(
      isAiEnabled({ ...SHIFT_CHECK_DEFAULTS, ai_check_enabled: false }, card),
    ).toBe(false);
    expect(
      isPhotoRequired({ ...SHIFT_CHECK_DEFAULTS, photo_required: false }, card),
    ).toBe(false);
    // Karta bayrog'i o'chiq (filial kartasi sukuti) — hech narsa majburiy emas.
    const off = {
      require_photo_on_shift_close: false,
      ai_check_enabled: false,
    };
    expect(isPhotoRequired(SHIFT_CHECK_DEFAULTS, off)).toBe(false);
    expect(isAiEnabled(SHIFT_CHECK_DEFAULTS, off)).toBe(false);
  });

  it('BE-A sukutlar: MAIN — tasdiqlash yoqiq, filial — o‘chiq; rasm / AI master yoqiq', () => {
    expect(SHIFT_CHECK_DEFAULTS).toEqual({
      account_check_enabled: true,
      branch_account_check_enabled: false,
      photo_required: true,
      ai_check_enabled: true,
    });
    expect(SHIFT_SETTING_KEYS).toEqual({
      accountCheckEnabled: 'shift.account_check.enabled',
      branchAccountCheckEnabled: 'shift.account_check.branch_enabled',
      photoRequired: 'shift.photo.required',
      aiCheckEnabled: 'shift.ai_check.enabled',
    });
  });

  it('BE-A amaldagi sozlama: MAIN — asosiy kalit, filial — filial kaliti; master kalitlar umumiy', () => {
    expect(effectiveShiftCheckSettings(SHIFT_CHECK_DEFAULTS, 'main')).toEqual({
      account_check_enabled: true,
      photo_required: true,
      ai_check_enabled: true,
    });
    expect(effectiveShiftCheckSettings(SHIFT_CHECK_DEFAULTS, 'branch')).toEqual(
      {
        account_check_enabled: false,
        photo_required: true,
        ai_check_enabled: true,
      },
    );
    const flipped = {
      account_check_enabled: false,
      branch_account_check_enabled: true,
      photo_required: false,
      ai_check_enabled: false,
    };
    expect(effectiveShiftCheckSettings(flipped, 'main')).toEqual({
      account_check_enabled: false,
      photo_required: false,
      ai_check_enabled: false,
    });
    expect(
      effectiveShiftCheckSettings(flipped, 'branch').account_check_enabled,
    ).toBe(true);
  });

  it('BE-A yangi karta sukuti: MAIN — rasm + AI, filial — o‘chiq', () => {
    expect(defaultCardShiftFlags('main')).toEqual({
      require_photo_on_shift_close: true,
      ai_check_enabled: true,
    });
    expect(defaultCardShiftFlags('branch')).toEqual({
      require_photo_on_shift_close: false,
      ai_check_enabled: false,
    });
  });
});
