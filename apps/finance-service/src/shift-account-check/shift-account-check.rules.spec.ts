import {
  deriveAiStatus,
  deriveEnteredOk,
  isAiEnabled,
  isCommentRequired,
  isPhotoRequired,
  SHIFT_CHECK_DEFAULTS,
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

  it('global master kalitlar × karta bayroqlari (sukut: AI o‘chiq)', () => {
    const card = { require_photo_on_shift_close: true, ai_check_enabled: true };
    expect(isPhotoRequired(SHIFT_CHECK_DEFAULTS, card)).toBe(true);
    expect(isAiEnabled(SHIFT_CHECK_DEFAULTS, card)).toBe(false);
    expect(
      isAiEnabled({ ...SHIFT_CHECK_DEFAULTS, ai_check_enabled: true }, card),
    ).toBe(true);
    expect(
      isPhotoRequired({ ...SHIFT_CHECK_DEFAULTS, photo_required: false }, card),
    ).toBe(false);
  });
});
