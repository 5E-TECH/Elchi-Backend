import {
  RECEIPT_EXTRACT_SYSTEM,
  ReceiptExtractService,
  maskCardLikeDigits,
  sanitizeCurrency,
  sanitizeReceiptDate,
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

  it.each([
    '8600 1234 5678 9012',
    '8600-1234-5678-9012',
    '8600.1234.5678.9012',
    '8600123456789012',
    '9860 0101 2345 6789',
  ])('⭐ guruhlangan karta raqami %s — uchala maydonda maskalanadi', (pan) => {
    const digits = pan.replace(/\D/g, '');
    for (const out of [
      sanitizeReference(pan),
      sanitizeReference(`TX ${pan}`),
      sanitizeText(`Ali Valiyev ${pan}`, 120),
      sanitizeReceiptDate(`30.10.2026 ${pan}`),
    ]) {
      expect(String(out)).not.toContain(digits);
      expect(String(out)).not.toMatch(/\d{4}[\s.-]?\d{4}[\s.-]?\d{4}/);
    }
    expect(sanitizeReference(pan)).toBeNull();
    expect(sanitizeReference(`TX ${pan}`)).toBe('TX***');
  });

  it('sana, summa, qisqa referens maskalanmaydi', () => {
    expect(maskCardLikeDigits('30.10.2026 14:05')).toBe('30.10.2026 14:05');
    expect(maskCardLikeDigits('150 000 so`m')).toBe('150 000 so`m');
    expect(sanitizeReceiptDate('2026-10-30 14:05')).toBe('2026-10-30 14:05');
    expect(sanitizeReference('TX-00123456')).toBe('TX-00123456');
  });
});
