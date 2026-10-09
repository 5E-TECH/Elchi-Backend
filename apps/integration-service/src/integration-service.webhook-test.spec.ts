import { computeHmacSignature } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * SINOV WEBHOOKI.
 *
 * Webhook zanjiri uch narsaga bog'liq: manzil yetib boradimi, imzo mos
 * keladimi, qabul qiluvchi 2xx qaytaradimi. Ilgari bularni bilish uchun
 * HAQIQIY sotuvni kutish kerak edi — prodakshnda sozlamani ko'r-ko'rona
 * qo'yib, birinchi real buyurtmada natijani ko'rish. Xato bo'lsa esa o'sha
 * buyurtmaning hodisasi yo'qolardi.
 */
function makeSvc(partner: Record<string, unknown> | null) {
  const logs: any[] = [];
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.partnerRepo = { findOne: jest.fn().mockResolvedValue(partner) };
  svc.activityLog = {
    log: jest.fn((p: any) => {
      logs.push(p);
      return Promise.resolve();
    }),
  };
  svc.assertOutboundUrlSafe = jest.fn().mockResolvedValue(undefined);
  svc.decryptCredential = jest.fn(() => 'top-secret');
  return { svc, logs };
}

const PARTNER = {
  id: '7',
  webhook_url: 'https://beepost.example.com/api/v1/elchi/webhook',
  webhook_secret: 'enc:whatever',
  isDeleted: false,
};

describe('Sinov webhooki', () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  it('TC1: 2xx -> ok:true, diagnostika to‘liq qaytadi', async () => {
    const { svc } = makeSvc(PARTNER);
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('{"message":"Sinov webhooki qabul qilindi"}'),
    }) as any;

    const res: any = await svc.testPartnerWebhook('7');

    expect(res.data.ok).toBe(true);
    expect(res.data.http_status).toBe(200);
    expect(res.data.used_saved_url).toBe(true);
    // Javob tanasi MUHIM: qabul qiluvchi 200 qaytarib ham "imzo yaroqsiz"
    // deyishi mumkin.
    expect(res.data.response_body).toContain('qabul qilindi');
    expect(res.data.signature_sent).toMatch(/^[0-9a-f]{64}$/);
    expect(res.data.secret_configured).toBe(true);
    expect(typeof res.data.duration_ms).toBe('number');
  });

  it('TC2: yuborilgan yuk `webhook.test` va test:true bayrog‘i bilan', async () => {
    const { svc } = makeSvc(PARTNER);
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ status: 200, text: () => Promise.resolve('ok') });
    global.fetch = fetchMock as any;

    await svc.testPartnerWebhook('7');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Qabul qiluvchi buni BUYURTMA sifatida ishlab yubormasligi kerak.
    expect(body.event).toBe('webhook.test');
    expect(body.test).toBe(true);
    expect(body.event_id).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].headers['X-Elchi-Signature']).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('TC3: 4xx/5xx -> ok:false, lekin XATO TASHLAMAYDI', async () => {
    // Operator natijani ko'rishi kerak, 500 olmasligi kerak.
    const { svc } = makeSvc(PARTNER);
    global.fetch = jest.fn().mockResolvedValue({
      status: 401,
      text: () => Promise.resolve('imzo yaroqsiz'),
    }) as any;

    const res: any = await svc.testPartnerWebhook('7');

    expect(res.data.ok).toBe(false);
    expect(res.data.http_status).toBe(401);
    expect(res.data.response_body).toContain('imzo yaroqsiz');
  });

  it('TC4: tarmoq xatosi -> ok:false va sabab qaytadi', async () => {
    const { svc } = makeSvc(PARTNER);
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as any;

    const res: any = await svc.testPartnerWebhook('7');

    expect(res.data.ok).toBe(false);
    expect(res.data.http_status).toBeNull();
    expect(res.data.error).toMatch(/ECONNREFUSED/);
  });

  it('TC5: `url` berilsa saqlanganidan USTUN turadi', async () => {
    // Yangi manzilni SAQLASHDAN OLDIN sinash imkoniyati.
    const { svc } = makeSvc(PARTNER);
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ status: 200, text: () => Promise.resolve('ok') });
    global.fetch = fetchMock as any;

    const res: any = await svc.testPartnerWebhook('7', {
      url: 'https://yangi.example.com/hook',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://yangi.example.com/hook');
    expect(res.data.used_saved_url).toBe(false);
  });

  it("TC6: manzil umuman yo'q -> aniq xato", async () => {
    const { svc } = makeSvc({ ...PARTNER, webhook_url: null });

    await expect(svc.testPartnerWebhook('7')).rejects.toThrow();
  });

  it('TC7: SSRF guard sinovda ham qo‘llanadi', async () => {
    // Sinov prodakshndan YUMSHOQROQ bo'lmasligi kerak — aks holda
    // "sinov o'tdi, real yiqildi" bo'lardi.
    const { svc } = makeSvc(PARTNER);
    svc.assertOutboundUrlSafe = jest
      .fn()
      .mockRejectedValue(new Error('Blocked outbound URL'));

    await expect(svc.testPartnerWebhook('7')).rejects.toThrow(/Blocked/);
  });

  it('TC8: natija auditga yoziladi (sir sizmaydi)', async () => {
    const { svc, logs } = makeSvc(PARTNER);
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('ok'),
    }) as any;

    await svc.testPartnerWebhook('7', null, { id: 'admin1', roles: ['admin'] });

    expect(logs).toHaveLength(1);
    const dumped = JSON.stringify(logs[0]);
    expect(dumped).toContain('webhook_test');
    expect(dumped).not.toContain('top-secret');
  });

  /**
   * ⚠️ SEKRET YO'Q BO'LSA SINOV HAM YUBORILMAYDI.
   *
   * Ilgari bo'sh kalit bilan imzolanardi va sinov "HTTP 401" ko'rsatardi —
   * operator sababni qabul qiluvchi tomondan izlardi, holbuki nuqson
   * Elchida edi. Haqiqiy yuborish bilan AYNI qoida.
   */
  it('TC9: webhook_secret yo‘q -> imzolanmaydi, so‘rov ketmaydi', async () => {
    const { svc } = makeSvc({ ...PARTNER, webhook_secret: null });
    svc.decryptCredential = jest.fn(() => null);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await expect(svc.testPartnerWebhook('7')).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Sinov webhooki — sandbox (jeU3eztP)', () => {
  const SANDBOX = 'https://abc.ngrok.app/api/v1/elchi/webhook';
  const withSandbox = (over: Record<string, unknown> = {}) => {
    const made = makeSvc({
      ...PARTNER,
      webhook_url: null,
      sandbox_enabled: true,
      sandbox_webhook_url: SANDBOX,
      sandbox_webhook_secret: 'enc:sandbox',
      ...over,
    });
    made.svc.decryptCredential = jest.fn((v: string | null) =>
      v === 'enc:sandbox' ? 'sandbox-secret' : v ? 'main-secret' : null,
    );
    return made;
  };
  const okFetch = () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('ok'),
    });
    global.fetch = fetchMock as any;
    return fetchMock;
  };
  const hmac = (body: string, key: string) =>
    computeHmacSignature(body, key, 'sha256', 'hex');

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('⭐ TC1: sandbox yoqiq + manzil bor, webhook_url yo`q — sandbox manziliga, SANDBOX sekreti bilan', async () => {
    const { svc } = withSandbox();
    const fetchMock = okFetch();

    const res: any = await svc.testPartnerWebhook('7');

    expect(fetchMock.mock.calls[0][0]).toBe(SANDBOX);
    const sent = fetchMock.mock.calls[0][1];
    expect(sent.headers['X-Elchi-Signature']).toBe(
      hmac(sent.body, 'sandbox-secret'),
    );
    // ⭐ TC2: javobda qaysi manzil va qaysi sekret
    expect(res.data).toMatchObject({
      target: 'sandbox',
      secret_used: 'sandbox',
      url: SANDBOX,
    });
  });

  it('target=main — asosiy manzil va asosiy sekret (sandbox yoqiq bo`lsa ham)', async () => {
    const { svc } = withSandbox({
      webhook_url: 'https://beepost.uz/api/v1/elchi/webhook',
      webhook_secret: 'enc:main',
    });
    const fetchMock = okFetch();

    const res: any = await svc.testPartnerWebhook('7', { target: 'main' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://beepost.uz/api/v1/elchi/webhook',
    );
    expect(res.data).toMatchObject({ target: 'main', secret_used: 'main' });
  });

  it('`url` = saqlangan sandbox manzili — sandbox sekreti bilan imzolanadi (401 emas)', async () => {
    const { svc } = withSandbox({ sandbox_enabled: false });
    const fetchMock = okFetch();

    const res: any = await svc.testPartnerWebhook('7', { url: SANDBOX });

    const sent = fetchMock.mock.calls[0][1];
    expect(sent.headers['X-Elchi-Signature']).toBe(
      hmac(sent.body, 'sandbox-secret'),
    );
    expect(res.data.secret_used).toBe('sandbox');
  });

  it('sandbox sekreti yo`q — asosiy sekretga QAYTMAYDI, so`rov ketmaydi', async () => {
    const { svc } = withSandbox({
      sandbox_webhook_secret: null,
      webhook_secret: 'enc:main',
    });
    const fetchMock = okFetch();

    await expect(svc.testPartnerWebhook('7')).rejects.toThrow(
      /sandbox_webhook_secret/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⭐ TC3: webhook_url ham, sandbox ham bo`sh — xato ikkalasini eslatadi', async () => {
    const { svc } = withSandbox({ sandbox_webhook_url: null });
    okFetch();
    await expect(svc.testPartnerWebhook('7')).rejects.toThrow(
      /webhook_url.*sandbox_webhook_url.*sandbox yoqilgan, lekin manzili yo'q/s,
    );
  });

  it('target=sandbox, lekin sandbox manzili bo`sh — aniq xato', async () => {
    const { svc } = withSandbox({
      sandbox_webhook_url: null,
      sandbox_enabled: false,
    });
    await expect(
      svc.testPartnerWebhook('7', { target: 'sandbox' }),
    ).rejects.toThrow(/sandbox_webhook_url` bo'sh/);
  });

  it('noto`g`ri target — 400', async () => {
    const { svc } = withSandbox();
    await expect(
      svc.testPartnerWebhook('7', { target: 'prod' }),
    ).rejects.toThrow(/target/);
  });
});
