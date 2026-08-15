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
      outboxSave: jest.fn(() => Promise.reject({ code: '23505' })),
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

  it('webhook_url yo‘q partner -> yubormaydi (skipped)', async () => {
    const svc: any = makeSvc({
      partnerFindOne: jest.fn(() =>
        Promise.resolve({ id: '7', webhook_url: null }),
      ),
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await svc.dispatchPartnerWebhook({
      id: '1',
      partner_id: '7',
      payload: SOLD_PAYLOAD,
    });

    expect(result).toEqual({ skipped: 'no webhook_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
