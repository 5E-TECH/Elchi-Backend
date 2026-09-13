import { IntegrationServiceService } from './integration-service.service';

/**
 * 3-BOSQICH: KICHIK SAYT UCHUN ODDIY QABUL YO'LI.
 *
 * MUAMMO (audit EI-01). Zanjir UZUQ edi: `search-by-qr` FAQAT ma'lumot olib
 * kelardi, buyurtma yaratmasdi; `receiveExternalOrders` esa alohida endpoint
 * edi. Ya'ni operator uchun ishlaydigan yo'l yo'q — Swagger'dan qo'lda JSON
 * tashlash kerak bo'lardi.
 *
 * Endi bitta amal: QR → saytning API'si → maydon xaritasi → buyurtma.
 */

function svc(over: Record<string, unknown> = {}) {
  const s = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & Record<string, any>;
  Object.assign(
    s,
    {
      findActiveBySlug: jest.fn().mockResolvedValue({
        id: '5',
        name: 'Donoxon',
        slug: 'donoxon',
        market_id: '500',
        field_mapping: {},
      }),
      searchByQr: jest.fn().mockResolvedValue({
        data: { id: 'EXT-9', phone: '+998901112233' },
      }),
      rmqRequestStrict: jest.fn().mockResolvedValue({
        data: { created: [{ id: '1001' }], skipped: [] },
      }),
      // RMQ mijozi — `rmqRequestStrict` ga birinchi argument bo'lib ketadi.
      orderClient: { send: jest.fn() },
      activityLog: { log: jest.fn().mockResolvedValue(undefined) },
      auditActor: () => ({}),
      badRequest: (m: string) => {
        throw Object.assign(new Error(m), { statusCode: 400 });
      },
      notFound: (m: string) => {
        throw Object.assign(new Error(m), { statusCode: 404 });
      },
    },
    over,
  );
  return s;
}

describe('scanIntake — QR dan buyurtmaga', () => {
  it('⭐ saytdan olib, buyurtma YARATADI', async () => {
    const s = svc();
    await (s as any).scanIntake({ slug: 'donoxon', qr_code: 'QR-1' });

    expect(s.searchByQr).toHaveBeenCalledWith({
      slug: 'donoxon',
      qr_code: 'QR-1',
    });
    expect(s.rmqRequestStrict).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.receive_external' },
      expect.objectContaining({ integration_id: '5' }),
      expect.any(Number),
    );
  });

  it('⭐ market bog\'lanmagan bo\'lsa ANIQ sabab beradi', async () => {
    /**
     * Eng ko'p uchraydigan sozlama xatosi (audit EI-02). "400 bad request"
     * operatorga hech narsa bermaydi — ulanish nomi va nima qilish kerakligi
     * xabarda bo'lishi kerak.
     */
    const s = svc({
      findActiveBySlug: jest.fn().mockResolvedValue({
        id: '5',
        name: 'Donoxon',
        slug: 'donoxon',
        market_id: null,
      }),
    });
    await expect(
      (s as any).scanIntake({ slug: 'donoxon', qr_code: 'QR-1' }),
    ).rejects.toThrow(/Donoxon.*market bog'lanmagan/);
    // Saytga so'rov ham yuborilmaydi — sozlama xato.
    expect(s.searchByQr).not.toHaveBeenCalled();
  });

  it('⭐ QR payloadda bo\'lmasa SKANERLANGAN qiymat qo\'shiladi', async () => {
    /**
     * Shu token buyurtmaning `qr_code_token`iga tushadi va posilkani
     * skanerlash keyin ham ishlaydi (yorliq saytda chop etilgan).
     */
    const s = svc();
    await (s as any).scanIntake({ slug: 'donoxon', qr_code: 'QR-77' });
    const payload = s.rmqRequestStrict.mock.calls[0][2];
    expect(payload.orders[0].qr_code).toBe('QR-77');
  });

  it('payloadda QR bor bo\'lsa TEGILMAYDI', async () => {
    const s = svc({
      searchByQr: jest
        .fn()
        .mockResolvedValue({ data: { id: 'E1', qr_code: 'SAYT-QR' } }),
    });
    await (s as any).scanIntake({ slug: 'donoxon', qr_code: 'SKANER-QR' });
    const payload = s.rmqRequestStrict.mock.calls[0][2];
    expect(payload.orders[0].qr_code).toBe('SAYT-QR');
  });

  it('sayt MASSIV qaytarsa ham ishlaydi', async () => {
    // Har sayt boshqacha qaytaradi — ikkisini ham qabul qilamiz.
    const s = svc({
      searchByQr: jest.fn().mockResolvedValue({ data: [{ id: 'E1' }, { id: 'E2' }] }),
    });
    await (s as any).scanIntake({ slug: 'donoxon', qr_code: 'QR-1' });
    expect(s.rmqRequestStrict.mock.calls[0][2].orders).toHaveLength(2);
  });

  it('QR bo\'sh bo\'lsa 400', async () => {
    const s = svc();
    await expect(
      (s as any).scanIntake({ slug: 'donoxon', qr_code: '  ' }),
    ).rejects.toThrow(/qr_code majburiy/);
  });

  it('⭐ saytda topilmasa 404 — buyurtma yaratilmaydi', async () => {
    const s = svc({ searchByQr: jest.fn().mockResolvedValue({ data: null }) });
    await expect(
      (s as any).scanIntake({ slug: 'donoxon', qr_code: 'QR-1' }),
    ).rejects.toThrow(/topilmadi/);
    expect(s.rmqRequestStrict).not.toHaveBeenCalled();
  });

  it('bo\'sh massiv ham "topilmadi"', async () => {
    const s = svc({ searchByQr: jest.fn().mockResolvedValue({ data: [] }) });
    await expect(
      (s as any).scanIntake({ slug: 'donoxon', qr_code: 'QR-1' }),
    ).rejects.toThrow(/topilmadi/);
  });

  it('order service javob bermasa 502', async () => {
    const s = svc({ rmqRequestStrict: jest.fn().mockResolvedValue(null) });
    await expect(
      (s as any).scanIntake({ slug: 'donoxon', qr_code: 'QR-1' }),
    ).rejects.toMatchObject({ error: { statusCode: 502 } });
  });
});
