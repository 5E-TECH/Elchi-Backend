import { createHash } from 'crypto';
import { computeHmacSignature } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * C2.3 — Elchi → hamkor chiquvchi webhook (outbox). Prototip orqali (og'ir
 * konstruktorsiz). `decryptCredential` uchun `primaryKey` qo'lda beriladi; test
 * sekreti `enc:` prefiksiz — plaintext qaytadi.
 */
function makeSvc(
  over: {
    refFindOne?: jest.Mock;
    outboxSave?: jest.Mock;
    outboxUpdate?: jest.Mock;
    partnerFindOne?: jest.Mock;
  } = {},
) {
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.partnerShipmentRefRepo = {
    findOne:
      over.refFindOne ??
      jest.fn(() =>
        Promise.resolve({
          partner_id: '7',
          external_order_id: 'ord-9',
          order_id: '900',
        }),
      ),
  };
  svc.partnerWebhookOutboxRepo = {
    create: jest.fn((x: unknown) => x),
    save:
      over.outboxSave ??
      jest.fn((x: any) => Promise.resolve({ id: '1', ...x })),
    find: jest.fn(() => Promise.resolve([])),
    update:
      over.outboxUpdate ?? jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  svc.partnerRepo = {
    findOne:
      over.partnerFindOne ??
      jest.fn(() =>
        Promise.resolve({
          id: '7',
          webhook_url: 'https://mp.example.com/webhooks/elchi',
          webhook_secret: 'topsecret',
        }),
      ),
  };
  svc.primaryKey = createHash('sha256').update('x'.repeat(40)).digest();
  svc.previousKey = null;
  svc.logger = { warn: jest.fn(), error: jest.fn() };
  // SSRF guard'ni test'da o'chiramiz (DNS/network chaqiruvi bo'lmasin).
  svc.assertOutboundUrlSafe = jest.fn(() => Promise.resolve());
  return svc as IntegrationServiceService;
}

const SOLD_PAYLOAD = {
  event: 'shipment.status_changed',
  external_order_id: 'ord-9',
  shipment_id: '900',
  status: 'sold',
  cod_collected: 50000,
};

describe('IntegrationServiceService — partner outbound webhook (C2.3)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('TC1: dispatch -> webhook_url ga POST + X-Elchi-Signature (HMAC)', async () => {
    const svc: any = makeSvc();
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const row = { id: '1', partner_id: '7', payload: SOLD_PAYLOAD };
    const result = await svc.dispatchPartnerWebhook(row);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://mp.example.com/webhooks/elchi');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.body).toBe(JSON.stringify(SOLD_PAYLOAD));
    // Imzo aynan body ustidan, dekript qilingan sekret bilan hisoblanadi.
    expect(opts.headers['X-Elchi-Signature']).toBe(
      computeHmacSignature(
        JSON.stringify(SOLD_PAYLOAD),
        'topsecret',
        'sha256',
        'hex',
      ),
    );
    expect(result).toEqual({ http_status: 200 });
  });

  it('TC2: 500 -> pending + backoff next_retry_at (attempts < max)', async () => {
    const patches: any[] = [];
    const outboxUpdate = jest.fn((_criteria: any, patch: any) => {
      patches.push(patch);
      return Promise.resolve({ affected: 1 });
    });
    const svc: any = makeSvc({ outboxUpdate });
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500 }),
    ) as unknown as typeof fetch;

    const row = {
      id: '1',
      partner_id: '7',
      attempts: 0,
      max_attempts: 4,
      payload: SOLD_PAYLOAD,
    };
    const ok = await svc.deliverPartnerWebhookRow(row);

    expect(ok).toBe(false);
    // Birinchi update — claim (pending->processing); oxirgisi — retry rejasi.
    expect(patches[0]).toMatchObject({ status: 'processing', attempts: 1 });
    const last = patches[patches.length - 1];
    expect(last.status).toBe('pending');
    expect(last.next_retry_at).toBeInstanceOf(Date);
    expect(String(last.last_error)).toContain('HTTP 500');
  });

  it('max urinishdan keyin -> permanently_failed', async () => {
    const patches: any[] = [];
    const svc: any = makeSvc({
      outboxUpdate: jest.fn((_c: any, p: any) => {
        patches.push(p);
        return Promise.resolve({ affected: 1 });
      }),
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500 }),
    ) as unknown as typeof fetch;

    const row = {
      id: '1',
      partner_id: '7',
      attempts: 3,
      max_attempts: 4,
      payload: SOLD_PAYLOAD,
    };
    await svc.deliverPartnerWebhookRow(row);

    expect(patches[patches.length - 1].status).toBe('permanently_failed');
  });

  it('⭐ settlement.payment: external_order_id bo`sh bo`lsa ham YETKAZILADI (permanently_failed EMAS)', async () => {
    /**
     * ⚠️ REGRESSIYA QO'RIQCHISI (485). settlement.payment MARKET darajasida —
     * buyurtmasi yo'q, external_order_id ATAYLAB bo'sh. Ilgari yetkazish
     * tekshiruvi uni "external_order_id yaroqsiz: bo'sh" deb DARHOL
     * permanently_failed qilardi va hamkorga HECH QACHON yetmasdi. Endi
     * settlement.payment uchun bu tekshiruv o'tkazib yuboriladi.
     */
    const patches: any[] = [];
    const svc: any = makeSvc({
      outboxUpdate: jest.fn((_c: any, p: any) => {
        patches.push(p);
        return Promise.resolve({ affected: 1 });
      }),
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"received":true}'),
      }),
    ) as unknown as typeof fetch;

    const row = {
      id: '1',
      partner_id: '7',
      attempts: 0,
      max_attempts: 4,
      event_type: 'settlement.payment',
      external_order_id: '', // settlement — buyurtmasi yo'q, bo'sh NORMAL
      payload: {
        event: 'settlement.payment',
        event_id: 'e1',
        payment_id: '259:abc',
        amount: 5000,
        paid_at: 1750000000000,
      },
    };
    await svc.deliverPartnerWebhookRow(row);

    // external_order_id bo'sh bo'lsa ham YETKAZISHGA urindi (rad etilmadi):
    expect(global.fetch).toHaveBeenCalled();
    const last = patches[patches.length - 1];
    expect(last.status).not.toBe('permanently_failed');
    expect(last.status).toBe('completed'); // 200 -> yetkazildi
  });

  it('claim affected=0 (boshqa worker oldi) -> yubormaydi', async () => {
    const svc: any = makeSvc({
      outboxUpdate: jest.fn(() => Promise.resolve({ affected: 0 })),
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await svc.deliverPartnerWebhookRow({
      id: '1',
      partner_id: '7',
      attempts: 0,
      max_attempts: 4,
      payload: SOLD_PAYLOAD,
    });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TC3: dedup — unique violation (23505) -> skip, throw yo‘q', async () => {
    const svc: any = makeSvc({
      outboxSave: jest.fn(() =>
        Promise.reject(
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        ),
      ),
    });
    svc.processPendingPartnerWebhooks = jest.fn(() =>
      Promise.resolve({ processed: 0, delivered: 0, failed: 0 }),
    );

    const res: any = await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'sold',
      cod_collected: 50000,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ skipped: 'duplicate' });
  });

  it('TC4: sold -> payload.cod_collected uzatiladi', async () => {
    const saved: any[] = [];
    const svc: any = makeSvc({
      outboxSave: jest.fn((x: any) => {
        saved.push(x);
        return Promise.resolve({ id: '1', ...x });
      }),
    });
    svc.processPendingPartnerWebhooks = jest.fn(() =>
      Promise.resolve({ processed: 0, delivered: 0, failed: 0 }),
    );

    const res: any = await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'sold',
      cod_collected: 50000,
    });

    expect(res.statusCode).toBe(201);
    expect(saved[0].payload).toMatchObject({
      event: 'shipment.status_changed',
      external_order_id: 'ord-9',
      shipment_id: '900',
      status: 'sold',
      cod_collected: 50000,
    });
  });

  it('cancelled -> cod_collected 0 (faqat sold uzatadi)', async () => {
    const saved: any[] = [];
    const svc: any = makeSvc({
      outboxSave: jest.fn((x: any) => {
        saved.push(x);
        return Promise.resolve({ id: '1', ...x });
      }),
    });
    svc.processPendingPartnerWebhooks = jest.fn(() =>
      Promise.resolve({ processed: 0, delivered: 0, failed: 0 }),
    );

    await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'cancelled',
      cod_collected: 50000,
    });

    expect(saved[0].payload.cod_collected).toBe(0);
  });

  // ===== G2 — takroriy status yo'qolmasligi =====

  it('G2: payload.event_id — UUID, imzolangan tanada bo‘ladi', async () => {
    const saved: any[] = [];
    const svc: any = makeSvc({
      outboxSave: jest.fn((x: any) => {
        saved.push(x);
        return Promise.resolve({ id: '1', ...x });
      }),
    });
    svc.processPendingPartnerWebhooks = jest.fn(() =>
      Promise.resolve({ processed: 0, delivered: 0, failed: 0 }),
    );

    await svc.enqueuePartnerWebhook({ order_id: '900', new_status: 'sold' });

    expect(saved[0].payload.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('G2: har enqueue YANGI event_id oladi — qabul qiluvchi takrorni ajratadi', async () => {
    const saved: any[] = [];
    const svc: any = makeSvc({
      outboxSave: jest.fn((x: any) => {
        saved.push(x);
        return Promise.resolve({ id: String(saved.length), ...x });
      }),
    });
    svc.processPendingPartnerWebhooks = jest.fn(() =>
      Promise.resolve({ processed: 0, delivered: 0, failed: 0 }),
    );

    // sold -> rollback -> yana sold: uchinchi hodisa BIRINCHISI bilan bir xil
    // statusга ega, lekin bu BOSHQA hodisa. Shu bois event_id'lar farq qilishi
    // SHART — aks holda qabul qiluvchi ikkinchi sotuvni "takror" deb tashlaydi.
    await svc.enqueuePartnerWebhook({ order_id: '900', new_status: 'sold' });
    await svc.enqueuePartnerWebhook({ order_id: '900', new_status: 'waiting' });
    await svc.enqueuePartnerWebhook({ order_id: '900', new_status: 'sold' });

    const ids = saved.map((r) => r.payload.event_id);
    expect(new Set(ids).size).toBe(3);
    // Uchinchisi birinchisi bilan bir xil status, lekin boshqa hodisa.
    expect(saved[2].new_status).toBe('sold');
    expect(saved[2].payload.event_id).not.toBe(saved[0].payload.event_id);
  });

  it('partner order emas (ref yo‘q) -> skipped, save chaqirilmaydi', async () => {
    const outboxSave = jest.fn();
    const svc: any = makeSvc({
      refFindOne: jest.fn(() => Promise.resolve(null)),
      outboxSave,
    });

    const res: any = await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'sold',
    });

    expect(res.data).toEqual({ skipped: 'not a partner order' });
    expect(outboxSave).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ INVARIANT TESKARISIGA O'ZGARDI.
   *
   * Ilgari bu test `{ skipped: 'no webhook_url' }` qaytarilishini talab
   * qilardi — chaqiruvchi esa shu "muvaffaqiyat"ni ko'rib qatorni
   * `completed` deb yopardi. Ya'ni sozlama yo'qligi hodisani BUTUNLAY
   * yo'qotardi va keyinroq `webhook_url` qo'yilganda ham hech narsa
   * yetkazilmasdi. Jonli holat aynan shunday bo'lgan: PCS lokalda,
   * `webhook_url` bo'sh, uchta sotuv hodisasi yo'qolgan.
   *
   * Endi signal tashlanadi va qator `awaiting_config`da KUTADI.
   */
  it('webhook_url yo‘q partner -> SIGNAL tashlaydi (jimgina yopilmaydi)', async () => {
    const svc: any = makeSvc({
      partnerFindOne: jest.fn(() =>
        Promise.resolve({ id: '7', webhook_url: null }),
      ),
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.dispatchPartnerWebhook({
        id: '1',
        partner_id: '7',
        payload: SOLD_PAYLOAD,
      }),
    ).rejects.toThrow(/webhook_url/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ BO'SH KALIT BILAN IMZOLASH — JONLI NUQSON.
   *
   * Ilgari `decryptCredential(...) ?? ''` turardi: sekret bo'lmasa imzo
   * BO'SH kalit bilan hisoblanib yuborilardi. Qabul qiluvchi uni yaroqsiz
   * deb 401 qaytarardi, Elchi esa 401'ni oddiy yetkazish xatosi deb qayta
   * urinardi — sozlama yo'qligi hech qayerda ko'rinmasdi.
   *
   * Jonli E2E'da qaytgan imzo AYNAN `hmac('', body)` bilan mos keldi va
   * pul ma'lumoti BeePostga yetmadi. Quyidagi ikki test shu imzo endi
   * hisoblanmasligini ham, umuman yuborilmasligini ham qamrab oladi.
   */
  it('webhook_secret yo‘q partner -> BO‘SH kalit bilan imzolanmaydi', async () => {
    const svc: any = makeSvc({
      partnerFindOne: jest.fn(() =>
        Promise.resolve({
          id: '7',
          webhook_url: 'https://mp.example.com/webhooks/elchi',
          webhook_secret: null,
        }),
      ),
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.dispatchPartnerWebhook({
        id: '1',
        partner_id: '7',
        payload: SOLD_PAYLOAD,
      }),
    ).rejects.toThrow(/webhook_secret/);

    // Hech narsa yuborilmadi — ya'ni `hmac('', body)` imzosi ham ketmadi.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('webhook_secret DESHIFRLANMASA ham yuborilmaydi', async () => {
    // Noto'g'ri kalit bilan shifrlangan qiymat: `decryptCredential` uni
    // OCHA OLMAY, `enc:` prefiksi bilan qaytaradi. Shifrmatn bilan
    // imzolash ham yaroqsiz imzo beradi — "sekret yo'q" bilan bir xil.
    const svc: any = makeSvc({
      partnerFindOne: jest.fn(() =>
        Promise.resolve({
          id: '7',
          webhook_url: 'https://mp.example.com/webhooks/elchi',
          webhook_secret: `enc:${'0'.repeat(32)}:${'0'.repeat(32)}`,
        }),
      ),
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.dispatchPartnerWebhook({
        id: '1',
        partner_id: '7',
        payload: SOLD_PAYLOAD,
      }),
    ).rejects.toThrow(/webhook_secret/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('IntegrationServiceService — qotgan "processing" reaper (sY4BsVGH)', () => {
  const realFetch = global.fetch;
  const realEnv = process.env.PARTNER_WEBHOOK_PROCESSING_STALE_MS;
  afterEach(() => {
    global.fetch = realFetch;
    if (realEnv === undefined) {
      delete process.env.PARTNER_WEBHOOK_PROCESSING_STALE_MS;
    } else {
      process.env.PARTNER_WEBHOOK_PROCESSING_STALE_MS = realEnv;
    }
    jest.restoreAllMocks();
  });

  it('eskirgan VA legacy "processing" qatorlarni "pending"ga qaytaradi; "attempts"ga TEGMAYDI', async () => {
    const calls: Array<{ where: any; set: any }> = [];
    const svc: any = makeSvc({
      outboxUpdate: jest.fn((where: any, set: any) => {
        calls.push({ where, set });
        return Promise.resolve({ affected: 1 });
      }),
    });
    const now = new Date('2026-06-01T12:00:00.000Z');

    const reaped = await svc.reapStalePartnerWebhooks(now);

    // Ikki update: (1) vaqtli-eskirgan, (2) legacy-null.
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.where.status).toBe('processing');
      expect(c.where.isDeleted).toBe(false);
      expect(c.set.status).toBe('pending');
      expect(c.set.next_retry_at).toBeNull();
      // ⚠️ attempts O'ZGARTIRILMAYDI — zaharli qator oxiri permanently_failed.
      expect('attempts' in c.set).toBe(false);
    }
    // (1) processing_started_at <= staleBefore
    expect((calls[0].where.processing_started_at as any).type).toBe(
      'lessThanOrEqual',
    );
    // (2) legacy: processing_started_at IS NULL + createdAt eski
    expect((calls[1].where.processing_started_at as any).type).toBe('isNull');
    expect((calls[1].where.createdAt as any).type).toBe('lessThanOrEqual');
    // Ikkala affected qo'shiladi; log yoziladi.
    expect(reaped).toBe(2);
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  it('getProcessingStaleMs: sukut 5 daqiqa, env bilan override, yaroqsiz -> sukut', () => {
    const svc: any = makeSvc();
    delete process.env.PARTNER_WEBHOOK_PROCESSING_STALE_MS;
    expect(svc.getProcessingStaleMs()).toBe(5 * 60_000);
    process.env.PARTNER_WEBHOOK_PROCESSING_STALE_MS = '120000';
    expect(svc.getProcessingStaleMs()).toBe(120000);
    process.env.PARTNER_WEBHOOK_PROCESSING_STALE_MS = 'garbage';
    expect(svc.getProcessingStaleMs()).toBe(5 * 60_000);
  });

  it('claim "processing_started_at" ni vaqt bilan belgilaydi, yetkazilgach TOZALAYDI', async () => {
    const calls: Array<{ where: any; set: any }> = [];
    const svc: any = makeSvc({
      outboxUpdate: jest.fn((where: any, set: any) => {
        calls.push({ where, set });
        return Promise.resolve({ affected: 1 });
      }),
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{}'),
      }),
    ) as unknown as typeof fetch;

    const row = {
      id: '1',
      partner_id: '7',
      attempts: 0,
      max_attempts: 4,
      event_type: 'shipment.status_changed',
      external_order_id: 'ord-9',
      payload: SOLD_PAYLOAD,
    };
    await svc.deliverPartnerWebhookRow(row);

    // Birinchi update = atomik claim: processing + vaqt yoziladi.
    expect(calls[0].where.status).toBe('pending');
    expect(calls[0].set.status).toBe('processing');
    expect(calls[0].set.processing_started_at instanceof Date).toBe(true);
    // Yakuniy update = completed: processing_started_at tozalandi (null).
    const last = calls[calls.length - 1].set;
    expect(last.status).toBe('completed');
    expect(last.processing_started_at).toBeNull();
  });
});
