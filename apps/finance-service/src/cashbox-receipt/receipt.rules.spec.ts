import {
  deriveReceiptFlags,
  deriveReceiptOutcome,
  parseReceiptDate,
} from './receipt.rules';
import { receiptReanalyzeBlock, isReceiptAiStale } from '@app/common';

/** T3-3 (QlLf33Ma) — chek AI natijasi qoidalari. */
describe('deriveReceiptOutcome', () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    ok: true,
    amount: 150_000,
    currency: 'UZS',
    confidence: 0.9,
    ...over,
  });

  it('⭐ chekda 150 000, kiritilgan 145 000 → mismatch, difference +5 000', () => {
    expect(deriveReceiptOutcome(ok(), 145_000)).toEqual({
      status: 'mismatch',
      difference: 5_000,
      error_reason: null,
    });
  });

  it('|farq| ≤ 1 so`m va UZS → match (valyuta ko`rsatilmagan — mahalliy)', () => {
    expect(
      deriveReceiptOutcome(ok({ amount: 145_000.6 }), 145_000).status,
    ).toBe('match');
    expect(deriveReceiptOutcome(ok({ currency: null }), 150_000).status).toBe(
      'match',
    );
  });

  it('boshqa valyuta — summa teng bo`lsa ham mismatch', () => {
    expect(
      deriveReceiptOutcome(ok({ currency: 'USD' }), 150_000),
    ).toMatchObject({ status: 'mismatch', difference: 0 });
  });

  it.each([
    ['refused', 'unreadable'],
    ['invalid_json', 'unreadable'],
    ['truncated', 'unreadable'],
    ['network', 'error'],
    ['cap_exceeded', 'error'],
    ['disabled', 'error'],
  ])('AI xatosi %s → %s', (reason, status) => {
    expect(deriveReceiptOutcome({ ok: false, reason }, 1000)).toEqual({
      status,
      difference: null,
      error_reason: reason,
    });
  });

  it.each([
    [{ amount: null }, 'no_amount'],
    [{ confidence: 0.49 }, 'low_confidence'],
    [{ confidence: null }, 'low_confidence'],
  ])('%j → unreadable', (over, reason) => {
    expect(deriveReceiptOutcome(ok(over), 1000)).toEqual({
      status: 'unreadable',
      difference: null,
      error_reason: reason,
    });
  });
});

describe('deriveReceiptFlags', () => {
  const base = {
    duplicate_photo: false,
    duplicate_reference: false,
    receipt_date: '30.10.2026 14:05',
    operation_at: new Date('2026-10-30T10:00:00Z'),
    expected_last4: ['1234'],
    detected_last4: '1234',
  };

  it('hammasi joyida — bayroq yo`q', () => {
    expect(deriveReceiptFlags(base)).toEqual([]);
  });

  it('takror rasm / referens, uzoq sana, boshqa karta', () => {
    expect(
      deriveReceiptFlags({
        ...base,
        duplicate_photo: true,
        duplicate_reference: true,
        receipt_date: '2026-10-20',
        detected_last4: '9999',
      }),
    ).toEqual([
      'duplicate_photo',
      'duplicate_reference',
      'date_far',
      'card_mismatch',
    ]);
  });

  it('3 kun ichida — date_far yo`q; tushunarsiz sana — yo`q; karta noma`lum — tekshirilmaydi', () => {
    expect(deriveReceiptFlags({ ...base, receipt_date: '27.10.2026' })).toEqual(
      [],
    );
    expect(deriveReceiptFlags({ ...base, receipt_date: 'kecha' })).toEqual([]);
    expect(
      deriveReceiptFlags({
        ...base,
        expected_last4: [],
        detected_last4: '9999',
      }),
    ).toEqual([]);
    expect(deriveReceiptFlags({ ...base, detected_last4: null })).toEqual([]);
  });

  it('parseReceiptDate', () => {
    expect(parseReceiptDate('30/10/2026')?.toISOString()).toBe(
      '2026-10-30T07:00:00.000Z',
    );
    expect(parseReceiptDate('2026-02-31')).toBeNull();
    expect(parseReceiptDate(42)).toBeNull();
  });
});

describe('receiptReanalyzeBlock (T3-2 can_reanalyze bilan bir qoida)', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const fresh = new Date(now - 60_000);
  const old = new Date(now - 4 * 60_000);

  it.each([
    [{ ai_status: 'mismatch', ai_attempts: 1 }, true, null],
    [{ ai_status: 'unreadable', ai_attempts: 1 }, true, null],
    [{ ai_status: 'error', ai_attempts: 1 }, true, null],
    [
      { ai_status: 'pending', ai_attempts: 0, ai_requested_at: old },
      true,
      null,
    ],
    [{ ai_status: 'match', ai_attempts: 1 }, true, 'RECEIPT_ALREADY_MATCHED'],
    [{ ai_status: 'disabled', ai_attempts: 0 }, true, 'RECEIPT_AI_DISABLED'],
    [{ ai_status: 'mismatch', ai_attempts: 1 }, false, 'RECEIPT_AI_DISABLED'],
    [
      { ai_status: 'pending', ai_attempts: 0, ai_requested_at: fresh },
      true,
      'RECEIPT_AI_PENDING',
    ],
    [
      { ai_status: 'error', ai_attempts: 5 },
      true,
      'RECEIPT_AI_ATTEMPTS_EXHAUSTED',
    ],
  ])('%j (AI yoqiq=%s) → %s', (row, aiOn, code) => {
    expect(receiptReanalyzeBlock(row, aiOn, now)).toBe(code);
  });

  it('ai_stale — faqat 3 daqiqadan oshgan pending', () => {
    expect(
      isReceiptAiStale({ ai_status: 'pending', ai_requested_at: old }, now),
    ).toBe(true);
    expect(
      isReceiptAiStale({ ai_status: 'pending', ai_requested_at: fresh }, now),
    ).toBe(false);
    expect(
      isReceiptAiStale({ ai_status: 'error', ai_requested_at: old }, now),
    ).toBe(false);
  });
});
