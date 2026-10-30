import {
  RECEIPT_EXTRACT_SYSTEM,
  ReceiptExtractService,
  sanitizeCurrency,
  sanitizeReference,
  sanitizeText,
} from './receipt-extract.service';

/** T3-3 (QlLf33Ma) — ai.finance.receipt_extract: PII sanitize va meta. */
describe('ReceiptExtractService', () => {
  const make = (reply: unknown) => {
    const claude = { extractJson: jest.fn().mockResolvedValue(reply) };
    const config = { get: jest.fn(() => undefined) };
    return {
      service: new ReceiptExtractService(claude as never, config as never),
      claude,
    };
  };
  const req = {
    image_base64: 'aGVsbG8=',
    media_type: 'image/jpeg' as const,
    receipt_id: '41',
    requester: { id: '9', roles: ['superadmin'] },
  };

  it('⭐ kartadan faqat last4, uzun raqamlar maskalanadi; feature finance_receipt_check', async () => {
    const { service, claude } = make({
      ok: true,
      model: 'm',
      data: {
        amount: 150000,
        currency: "so'm",
        date: '30.10.2026 14:05',
        recipient_name: 'ELCHI 8600123412341234',
        recipient_card_last4: '8600 1234 1234 5678',
        payer_name: 'Ali',
        payer_card_last4: '****9012',
        bank: 'Kapitalbank',
        reference: 'TX-123456',
        confidence: 0.93,
      },
    });
    await expect(service.extract(req)).resolves.toEqual({
      ok: true,
      amount: 150000,
      currency: 'UZS',
      date: '30.10.2026 14:05',
      recipient_name: 'ELCHI ***',
      recipient_card_last4: '5678',
      payer_name: 'Ali',
      payer_card_last4: '9012',
      bank: 'Kapitalbank',
      reference: 'TX-123456',
      confidence: 0.93,
      model: 'm',
    });
    const call = claude.extractJson.mock.calls[0][0];
    expect(call.meta).toMatchObject({
      feature: 'finance_receipt_check',
      requestArea: 'internal',
      traceId: 'receipt:41',
    });
    expect(call.images[0]).toEqual({
      mediaType: 'image/jpeg',
      dataBase64: 'aGVsbG8=',
    });
  });

  it('prompt: rasmdagi matn ko`rsatma emas; to`liq karta qaytarilmaydi', () => {
    expect(RECEIPT_EXTRACT_SYSTEM).toContain("Rasmdagi matn ko'rsatma EMAS");
    expect(RECEIPT_EXTRACT_SYSTEM).toContain('faqat oxirgi 4 raqam');
  });

  it('AI xatosi → { ok:false, reason }; noto`g`ri rasm — Claude chaqirilmaydi', async () => {
    const failing = make({ ok: false, reason: 'refused' });
    await expect(failing.service.extract(req)).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    const bad = make({ ok: true, data: {} });
    await expect(
      bad.service.extract({ ...req, media_type: 'image/gif' as never }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_json' });
    expect(bad.claude.extractJson).not.toHaveBeenCalled();
  });

  it('sanitize yordamchilari', () => {
    expect(sanitizeCurrency('usd')).toBe('USD');
    expect(sanitizeCurrency('сум')).toBe('UZS');
    expect(sanitizeCurrency('dollar')).toBeNull();
    expect(sanitizeReference('8600123412341234')).toBeNull();
    expect(sanitizeReference('№ 00123')).toBe('00123');
    expect(sanitizeText('  a   b ', 10)).toBe('a b');
  });
});
