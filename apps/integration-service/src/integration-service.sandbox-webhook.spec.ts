import { IntegrationServiceService } from './integration-service.service';

/**
 * SANDBOX KO'ZGUSI.
 *
 * Prodakshnda `webhook_url` haqiqiy qabul qiluvchiga qaratilgan va unga tegib
 * bo'lmaydi. Integratsiyani tekshirish uchun esa HAQIQIY hodisalar oqimini
 * ko'rish kerak — sinov buyurtmasi yaratmasdan. Shu bois har bir hodisaning
 * nusxasi `sandbox_webhook_url`ga ham yuboriladi.
 *
 * ⚠️ ENG MUHIM INVARIANT: sandbox sinov kanali. Uning xatosi asosiy
 * yetkazishga TA'SIR QILMASLIGI shart — aks holda sinov muhiti yiqilganda
 * haqiqiy hodisalar `permanently_failed` bo'lib yo'qolardi.
 */
function makeSvc(partner: Record<string, unknown>) {
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.partnerRepo = { findOne: jest.fn().mockResolvedValue(partner) };
  svc.assertOutboundUrlSafe = jest.fn().mockResolvedValue(undefined);
  svc.decryptCredential = jest.fn((v: unknown) =>
    v === 'enc:main' ? 'main-secret' : v === 'enc:sb' ? 'sb-secret' : null,
  );
  return svc;
}

const ROW = {
  id: 'w-1',
  partner_id: '7',
  payload: { event: 'shipment.status_changed', status: 'sold' },
};

const MAIN = 'https://prod.example.com/hook';
const SB = 'https://dev.example.com/hook';

/** Har bir manzil uchun alohida javob beradigan fetch mock. */
function fetchByUrl(map: Record<string, any>) {
  return jest.fn((url: string) => {
    const r = map[url];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r ?? { ok: true, status: 200 });
  });
}

describe("Sandbox ko'zgusi", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  it('TC1: sandbox qo‘yilgan -> IKKI manzilga yuboriladi', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: SB,
    });
    const f = fetchByUrl({});
    global.fetch = f as any;

    await svc.dispatchPartnerWebhook({ ...ROW });
    await new Promise((r) => setImmediate(r)); // ko'zgu `void` — navbatni bo'shatamiz

    const urls = f.mock.calls.map((c: any[]) => c[0]);
    expect(urls).toContain(MAIN);
    expect(urls).toContain(SB);
  });

  it('TC2: ko‘zgu yukida `sandbox: true` bayrog‘i bor', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: SB,
    });
    const f = fetchByUrl({});
    global.fetch = f as any;

    await svc.dispatchPartnerWebhook({ ...ROW });
    await new Promise((r) => setImmediate(r));

    const sbCall = f.mock.calls.find((c: any[]) => c[0] === SB);
    const body = JSON.parse(sbCall[1].body);
    // Busiz sinov muhiti va prodakshn bir xil yukni ko'rib, loglarda
    // ularni farqlash imkonsiz bo'lardi.
    expect(body.sandbox).toBe(true);
    expect(body.status).toBe('sold');
    expect(sbCall[1].headers['X-Elchi-Sandbox']).toBe('1');

    // Asosiy yukda bayroq BO'LMASLIGI kerak.
    const mainCall = f.mock.calls.find((c: any[]) => c[0] === MAIN);
    expect(JSON.parse(mainCall[1].body).sandbox).toBeUndefined();
  });

  it('TC3: ⭐ sandbox YIQILSA asosiy yetkazish MUVAFFAQIYATLI qoladi', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: SB,
    });
    global.fetch = fetchByUrl({
      [MAIN]: { ok: true, status: 200 },
      [SB]: new Error('ECONNREFUSED'),
    }) as any;

    // Xato TASHLAMASLIGI shart — aks holda haqiqiy hodisa qayta urinishga
    // tushib, oxirida `permanently_failed` bo'lib yo'qolardi.
    const res = await svc.dispatchPartnerWebhook({ ...ROW });
    await new Promise((r) => setImmediate(r));

    expect(res).toEqual({ http_status: 200 });
  });

  it('TC4: sandbox 5xx qaytarsa ham asosiy natija o‘zgarmaydi', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: SB,
    });
    global.fetch = fetchByUrl({
      [MAIN]: { ok: true, status: 200 },
      [SB]: { ok: false, status: 500 },
    }) as any;

    const res = await svc.dispatchPartnerWebhook({ ...ROW });
    await new Promise((r) => setImmediate(r));

    expect(res).toEqual({ http_status: 200 });
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  it("TC5: ASOSIY yiqilsa xato tashlanadi (sandbox uni yashirmaydi)", async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: SB,
    });
    global.fetch = fetchByUrl({
      [MAIN]: { ok: false, status: 502 },
      [SB]: { ok: true, status: 200 },
    }) as any;

    await expect(svc.dispatchPartnerWebhook({ ...ROW })).rejects.toThrow(/502/);
  });

  it('TC6: alohida sandbox sekreti bo‘lsa O‘SHA ishlatiladi', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: SB,
      sandbox_webhook_secret: 'enc:sb',
    });
    const f = fetchByUrl({});
    global.fetch = f as any;

    await svc.dispatchPartnerWebhook({ ...ROW });
    await new Promise((r) => setImmediate(r));

    const sbSig = f.mock.calls.find((c: any[]) => c[0] === SB)[1].headers[
      'X-Elchi-Signature'
    ];
    const mainSig = f.mock.calls.find((c: any[]) => c[0] === MAIN)[1].headers[
      'X-Elchi-Signature'
    ];
    expect(sbSig).not.toBe(mainSig);
  });

  it("TC7: sandbox sozlanmagan -> FAQAT asosiy manzil", async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: null,
    });
    const f = fetchByUrl({});
    global.fetch = f as any;

    await svc.dispatchPartnerWebhook({ ...ROW });
    await new Promise((r) => setImmediate(r));

    expect(f.mock.calls).toHaveLength(1);
    expect(f.mock.calls[0][0]).toBe(MAIN);
  });

  it('TC8: sandbox manzili SSRF guardidan o‘tadi', async () => {
    const svc = makeSvc({
      id: '7',
      webhook_url: MAIN,
      webhook_secret: 'enc:main',
      sandbox_webhook_url: SB,
    });
    // Guard asosiy manzilga ruxsat beradi, sandboxni bloklaydi.
    svc.assertOutboundUrlSafe = jest.fn((u: string) =>
      u === SB
        ? Promise.reject(new Error('Blocked outbound URL'))
        : Promise.resolve(),
    );
    const f = fetchByUrl({});
    global.fetch = f as any;

    const res = await svc.dispatchPartnerWebhook({ ...ROW });
    await new Promise((r) => setImmediate(r));

    // Bloklangan sandbox asosiy yetkazishni buzmaydi.
    expect(res).toEqual({ http_status: 200 });
    expect(f.mock.calls.map((c: any[]) => c[0])).toEqual([MAIN]);
  });
});
