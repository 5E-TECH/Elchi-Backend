import { createHash } from 'crypto';
import { IntegrationServiceService } from './integration-service.service';

/**
 * F5 — yaroqsiz `external_order_id` va DOIMIY (4xx) xatolar.
 *
 * Jonli E2E (BeePost↔Elchi, 6 ta Andijon buyurtmasi): jo'natish 6/6 ishladi,
 * lekin PUL ma'lumoti hamkorga yetmadi. Sabab zanjiri:
 *   yaroqsiz `external_order_id` → qabul qiluvchida Postgres `22P02` → 500
 *   → Elchi buni "vaqtinchalik" deb 4 marta qayta urdi → `permanently_failed`
 *   → hodisa butunlay yo'qoldi.
 *
 * Qulflanadigan invariantlar:
 *   - shakl buzilgan bo'lsa hodisa YUBORILMAYDI (urinish ham qilinmaydi);
 *   - lekin JIMGINA tashlanmaydi — qator monitorda aniq sababi bilan turadi;
 *   - 4xx = doimiy (qayta urinish yo'q), 5xx va 408/425/429 = vaqtinchalik.
 */
type Row = Record<string, any>;

function makeSvc(
  over: {
    refFindOne?: jest.Mock;
    outboxSave?: jest.Mock;
    outboxUpdate?: jest.Mock;
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
      jest.fn((x: Row) => Promise.resolve({ id: '1', ...x })),
    find: jest.fn(() => Promise.resolve([])),
    update:
      over.outboxUpdate ?? jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  svc.partnerRepo = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: '7',
        webhook_url: 'https://mp.example.com/webhooks/elchi',
        webhook_secret: 'topsecret',
      }),
    ),
  };
  svc.primaryKey = createHash('sha256').update('x'.repeat(40)).digest();
  svc.previousKey = null;
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
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

describe('IntegrationServiceService — external_order_id shakli (F5)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function makeEnqueueSvc(externalOrderId: string) {
    const saved: Row[] = [];
    const svc: any = makeSvc({
      refFindOne: jest.fn(() =>
        Promise.resolve({
          partner_id: '7',
          external_order_id: externalOrderId,
          order_id: '900',
        }),
      ),
      outboxSave: jest.fn((x: Row) => {
        saved.push(x);
        return Promise.resolve({ id: '1', ...x });
      }),
    });
    svc.processPendingPartnerWebhooks = jest.fn(() =>
      Promise.resolve({ processed: 0, delivered: 0, failed: 0 }),
    );
    return { svc, saved };
  }

  it('UUID — normal yo‘l bilan navbatga tushadi', async () => {
    const { svc, saved } = makeEnqueueSvc(
      'a3f1c8e2-7b44-4d91-9f02-1c5e6d8a4b30',
    );

    const res: any = await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'sold',
    });

    expect(res.statusCode).toBe(201);
    expect(saved[0].status).toBe('pending');
    expect(svc.processPendingPartnerWebhooks).toHaveBeenCalled();
  });

  it('`ord-9` kabi kelishilgan shakl ham O‘TADI (UUID majburiy emas)', async () => {
    const { svc, saved } = makeEnqueueSvc('ord-9');

    const res: any = await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'sold',
    });

    expect(res.statusCode).toBe(201);
    expect(saved[0].status).toBe('pending');
  });

  it.each([
    ["bo'sh", '   '],
    ['ichida bo‘sh joy', 'ord 9'],
    ['satr ko‘chirish', 'ord-9\n'],
    ['qo‘shtirnoq', 'ord-"9"'],
    ['juda uzun', 'a'.repeat(65)],
  ])('yaroqsiz (%s) -> YUBORILMAYDI', async (_name, badId) => {
    const { svc, saved } = makeEnqueueSvc(badId);

    const res: any = await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'sold',
      cod_collected: 50000,
    });

    // Eng muhimi: bekorga 4 marta urinish YO'Q.
    expect(svc.processPendingPartnerWebhooks).not.toHaveBeenCalled();
    expect(res.data.rejected).toBe('invalid external_order_id');
    expect(saved[0].status).toBe('permanently_failed');
  });

  it('rad etilgan hodisa JIMGINA yo‘qolmaydi — sabab qatorda va jurnalda', async () => {
    const { svc, saved } = makeEnqueueSvc('ord 9');

    const res: any = await svc.enqueuePartnerWebhook({
      order_id: '900',
      new_status: 'sold',
    });

    // Sabab "HTTP 500" emas, ANIQ — admin monitorida shu ko'rinadi.
    expect(String(saved[0].last_error)).toContain('external_order_id yaroqsiz');
    expect(res.data.reason).toBeTruthy();
    expect(svc.logger.error).toHaveBeenCalled();
    // Payload saqlanadi — ref tuzatilgach qo'lda "retry" qilish mumkin.
    expect(saved[0].payload.shipment_id).toBe('900');
  });

  it('qayta navbat (admin retry) ham yaroqsiz id‘ni YUBORMAYDI', async () => {
    const svc: any = makeSvc();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.dispatchPartnerWebhook({
        id: '1',
        partner_id: '7',
        external_order_id: 'ord 9',
        payload: { ...SOLD_PAYLOAD, external_order_id: 'ord 9' },
      }),
    ).rejects.toThrow(/external_order_id yaroqsiz/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('yaroqsiz id yetkazuvchida -> DARHOL permanently_failed (backoff yo‘q)', async () => {
    const patches: Row[] = [];
    const svc: any = makeSvc({
      outboxUpdate: jest.fn((_c: Row, p: Row) => {
        patches.push(p);
        return Promise.resolve({ affected: 1 });
      }),
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await svc.deliverPartnerWebhookRow({
      id: '1',
      partner_id: '7',
      attempts: 0,
      max_attempts: 4,
      external_order_id: 'ord 9',
      payload: { ...SOLD_PAYLOAD, external_order_id: 'ord 9' },
    });

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const last = patches[patches.length - 1];
    expect(last.status).toBe('permanently_failed');
    expect(last.next_retry_at).toBeNull();
  });
});

describe('IntegrationServiceService — 4xx va 5xx ajratiladi (F5)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  async function deliver(status: number, body = ''): Promise<Row> {
    const patches: Row[] = [];
    const svc: any = makeSvc({
      outboxUpdate: jest.fn((_c: Row, p: Row) => {
        patches.push(p);
        return Promise.resolve({ affected: 1 });
      }),
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status,
        text: () => Promise.resolve(body),
      }),
    ) as unknown as typeof fetch;

    await svc.deliverPartnerWebhookRow({
      id: '1',
      partner_id: '7',
      attempts: 0,
      max_attempts: 4,
      payload: SOLD_PAYLOAD,
    });
    return patches[patches.length - 1];
  }

  it.each([400, 401, 403, 404, 422])(
    'HTTP %i -> DOIMIY xato, qayta urinilmaydi',
    async (status) => {
      const last = await deliver(status);
      expect(last.status).toBe('permanently_failed');
      // Backoff rejasi YO'Q — kutish javobni o'zgartirmaydi.
      expect(last.next_retry_at).toBeNull();
    },
  );

  it.each([408, 425, 429])(
    'HTTP %i -> ISTISNO: vaqtinchalik, backoff bilan qayta uriladi',
    async (status) => {
      const last = await deliver(status);
      // 429 ni doimiy deb yopish hodisani butunlay yo'qotardi.
      expect(last.status).toBe('pending');
      expect(last.next_retry_at).toBeInstanceOf(Date);
    },
  );

  it.each([500, 502, 503])(
    'HTTP %i -> VAQTINCHALIK qoladi (backoff)',
    async (status) => {
      const last = await deliver(status);
      expect(last.status).toBe('pending');
      expect(last.next_retry_at).toBeInstanceOf(Date);
    },
  );

  it('javob tanasi sababni ko‘rsatadi (qisqartirilgan)', async () => {
    const last = await deliver(
      400,
      'invalid input syntax for type uuid: "ord-9"',
    );
    expect(String(last.last_error)).toContain('HTTP 400');
    expect(String(last.last_error)).toContain('invalid input syntax');
  });

  it('tana o‘qilmasa ham xato xabari YO‘QOLMAYDI', async () => {
    const patches: Row[] = [];
    const svc: any = makeSvc({
      outboxUpdate: jest.fn((_c: Row, p: Row) => {
        patches.push(p);
        return Promise.resolve({ affected: 1 });
      }),
    });
    // `text()` umuman yo'q (stream yopilgan) — kod yiqilmasligi kerak.
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500 }),
    ) as unknown as typeof fetch;

    await svc.deliverPartnerWebhookRow({
      id: '1',
      partner_id: '7',
      attempts: 0,
      max_attempts: 4,
      payload: SOLD_PAYLOAD,
    });

    expect(String(patches[patches.length - 1].last_error)).toContain(
      'HTTP 500',
    );
  });
});
