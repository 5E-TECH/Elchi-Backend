import {
  BalanceScreenshotService,
  sanitizeDate,
  sanitizeLast4,
} from './balance-screenshot.service';

/**
 * kiZgTybn — `ai.finance.balance_screenshot`. ClaudeService MOCK (haqiqiy
 * pulli AI chaqirilmaydi).
 */
describe('BalanceScreenshotService (kiZgTybn)', () => {
  const make = (result: unknown) => {
    const claude = { extractJson: jest.fn().mockResolvedValue(result) };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    return {
      claude,
      service: new BalanceScreenshotService(claude as never, config as never),
    };
  };
  const req = {
    image_base64: Buffer.from('img').toString('base64'),
    media_type: 'image/jpeg' as const,
    shift_id: '12',
    card_id: '3',
    requester: { id: '25', roles: ['registrator'] },
  };

  it('rasm + sxema yuboriladi, feature finance_balance_screenshot / internal; to‘liq PAN kesiladi', async () => {
    const { claude, service } = make({
      ok: true,
      model: 'claude-sonnet-5',
      attempts: 1,
      usage: {},
      data: {
        balance: 1250000.5,
        last4: '8600 1234 5678 9012',
        date: '26.10.2026 karta 8600123456789012',
        confidence: 1.7,
      },
    });
    const res = await service.check(req, Date.now() + 30_000);
    expect(res).toEqual({
      ok: true,
      balance: 1250000.5,
      last4: '9012',
      date: '26.10.2026 karta ***',
      confidence: 1,
      model: 'claude-sonnet-5',
    });
    const opts = claude.extractJson.mock.calls[0][0];
    expect(opts.images).toEqual([
      { mediaType: 'image/jpeg', dataBase64: req.image_base64 },
    ]);
    expect(opts.meta).toEqual(
      expect.objectContaining({
        feature: 'finance_balance_screenshot',
        requestArea: 'internal',
        userId: '25',
        traceId: 'shift:12:card:3',
      }),
    );
    expect(opts.schema.required).toEqual([
      'balance',
      'last4',
      'date',
      'confidence',
    ]);
  });

  it('AI xatosi / cap — sabab bilan ok:false (throw yo‘q)', async () => {
    const { service } = make({
      ok: false,
      reason: 'cap_exceeded',
      scope: 'global',
      reset_at: 'x',
      attempts: 0,
    });
    await expect(service.check(req)).resolves.toEqual({
      ok: false,
      reason: 'cap_exceeded',
    });
  });

  it('noto‘g‘ri tur yoki bo‘sh rasm — Anthropic chaqirilmaydi', async () => {
    const { claude, service } = make({ ok: true });
    await expect(
      service.check({ ...req, media_type: 'image/gif' as never }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_json' });
    await expect(service.check({ ...req, image_base64: '' })).resolves.toEqual({
      ok: false,
      reason: 'invalid_json',
    });
    expect(claude.extractJson).not.toHaveBeenCalled();
  });

  it('sanitize yordamchilari', () => {
    expect(sanitizeLast4('**** 4321')).toBe('4321');
    expect(sanitizeLast4('12')).toBeNull();
    expect(sanitizeLast4(null)).toBeNull();
    expect(sanitizeDate('')).toBeNull();
  });

  it('⭐ sanitizeDate: guruhlangan karta raqami niqoblanadi, sana-vaqt saqlanadi', () => {
    expect(sanitizeDate('30.10.2026 8600 1234 5678 9012')).toBe(
      '30.10.2026 ***',
    );
    expect(sanitizeDate('30.10.2026 8600-1234-5678-9012')).toBe(
      '30.10.2026 ***',
    );
    expect(sanitizeDate('30.10.2026 14.05.33')).toBe('30.10.2026 14.05.33');
    expect(sanitizeDate('2026-10-30 14:05')).toBe('2026-10-30 14:05');
  });
});
