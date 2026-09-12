import { IntegrationServiceService } from './integration-service.service';

/**
 * INTEGRATSIYA METRIKASI.
 *
 * Panel ilgari faqat checklist ko'rsatardi ("sozlangan / sozlanmagan"). Lekin
 * operatorning haqiqiy savoli boshqa — "ISHLAYAPTIMI?". Sozlama to'g'ri
 * bo'lib, hodisalar yetmayotgan bo'lishi mumkin (hamkor 500 qaytaradi, sekret
 * almashtirilgan, manzil o'zgargan). Busiz muammo faqat hamkor telefon
 * qilganda ma'lum bo'lardi.
 *
 * Bu test asosan BITTA narsani qulflaydi: panel HECH QACHON soxta raqam
 * ko'rsatmasligi kerak. O'lchanmagan qiymat `null` bo'ladi, 0 EMAS.
 */
function makeSvc(opts: {
  partnerRows?: any[];
  historyRows?: any[];
  queueRows?: any[];
}) {
  const qb = (rows: any[]) => {
    const b: any = {};
    for (const m of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'setParameter',
      'groupBy',
    ]) {
      b[m] = jest.fn(() => b);
    }
    b.getRawMany = jest.fn(async () => rows);
    return b;
  };

  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.partnerWebhookOutboxRepo = {
    createQueryBuilder: jest.fn(() => qb(opts.partnerRows ?? [])),
  };
  svc.syncHistoryRepo = {
    createQueryBuilder: jest.fn(() => qb(opts.historyRows ?? [])),
  };
  svc.syncQueueRepo = {
    createQueryBuilder: jest.fn(() => qb(opts.queueRows ?? [])),
  };
  return svc;
}

const unwrap = (res: any) => res.data;

describe('integrationMetrics — oyna', () => {
  it('TC1: standart 24 soat', async () => {
    const svc = makeSvc({});
    expect(unwrap(await svc.integrationMetrics()).window_hours).toBe(24);
  });

  it('TC2: oyna chegaralanadi (1..168)', async () => {
    // Cheklovsiz katta oyna butun jadvalni skanerlab, panelni muzlatardi.
    const svc = makeSvc({});
    expect(unwrap(await svc.integrationMetrics(0)).window_hours).toBe(24);
    expect(unwrap(await svc.integrationMetrics(-5)).window_hours).toBe(1);
    expect(unwrap(await svc.integrationMetrics(9999)).window_hours).toBe(168);
    expect(unwrap(await svc.integrationMetrics(48)).window_hours).toBe(48);
  });
});

describe('integrationMetrics — hamkor (inbound)', () => {
  it('TC3: raqamlar va uid to‘g‘ri yig‘iladi', async () => {
    const svc = makeSvc({
      partnerRows: [
        {
          id: '7',
          events: '128',
          delivered: '125',
          failed: '3',
          queued: '7',
          avg_ms: '184.6',
          last_at: new Date('2026-09-12T09:41:00Z'),
        },
      ],
    });

    const c = unwrap(await svc.integrationMetrics()).connections[0];

    expect(c.uid).toBe('partner:7');
    expect(c.kind).toBe('partner');
    expect(c.events).toBe(128);
    expect(c.failed).toBe(3);
    expect(c.queued).toBe(7);
    expect(c.avg_ms).toBe(185); // yaxlitlanadi
    expect(c.last_event_at).toBe('2026-09-12T09:41:00.000Z');
  });

  it('TC4: ⭐ muvaffaqiyat foizi FAQAT yakunlanganlar ustida', async () => {
    /**
     * Navbatda turganini hisobga olsak, foiz hodisalar ko'paygan sayin
     * sun'iy tushib ketardi: "98% -> 62%" degan o'zgarish operatorni bejiz
     * qo'rqitardi.
     */
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '100', delivered: '90', failed: '10', queued: '50' },
      ],
    });

    // 90 / (90+10) = 90%, navbatdagi 50 ta hisobga OLINMAYDI
    expect(unwrap(await svc.integrationMetrics()).connections[0].success_rate).toBe(90);
  });

  it("TC5: ⭐ yakunlangan hodisa YO'Q -> foiz `null` (0% EMAS)", async () => {
    // 0% "hammasi yiqildi" degan yolg'on xabar bo'lardi.
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '5', delivered: '0', failed: '0', queued: '5' },
      ],
    });

    expect(unwrap(await svc.integrationMetrics()).connections[0].success_rate).toBeNull();
  });

  it("TC6: ⭐ javob vaqti o'lchanmagan -> `null` (0 EMAS)", async () => {
    // 0 ms "bir zumda javob berdi" degan yolg'on bo'lardi.
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '2', delivered: '2', failed: '0', queued: '0', avg_ms: null },
      ],
    });

    expect(unwrap(await svc.integrationMetrics()).connections[0].avg_ms).toBeNull();
  });

  it("TC7: hodisa yo'q -> last_event_at `null`", async () => {
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '0', delivered: '0', failed: '0', queued: '0', last_at: null },
      ],
    });

    expect(unwrap(await svc.integrationMetrics()).connections[0].last_event_at).toBeNull();
  });
});

describe('integrationMetrics — integratsiya (outbound)', () => {
  it('TC8: navbat ALOHIDA jadvaldan qo‘shiladi', async () => {
    // `sync_history` da navbat yo'q — u `sync_queue` da.
    const svc = makeSvc({
      historyRows: [{ id: '12', events: '19', delivered: '19', failed: '0' }],
      queueRows: [{ id: '12', queued: '4' }],
    });

    const c = unwrap(await svc.integrationMetrics()).connections[0];

    expect(c.uid).toBe('integration:12');
    expect(c.events).toBe(19);
    expect(c.queued).toBe(4);
  });

  it("TC9: navbat qatori yo'q -> 0 (undefined EMAS)", async () => {
    const svc = makeSvc({
      historyRows: [{ id: '12', events: '3', delivered: '3', failed: '0' }],
      queueRows: [],
    });

    expect(unwrap(await svc.integrationMetrics()).connections[0].queued).toBe(0);
  });

  it("TC10: ⭐ outbound javob vaqti HAMISHA `null`", async () => {
    // `sync_history` da bunday ustun yo'q. 0 yozish yolg'on bo'lardi.
    const svc = makeSvc({
      historyRows: [{ id: '12', events: '3', delivered: '3', failed: '0' }],
    });

    expect(unwrap(await svc.integrationMetrics()).connections[0].avg_ms).toBeNull();
  });
});

describe('integrationMetrics — jami', () => {
  it('TC11: ikki manba jami bo‘yicha qo‘shiladi', async () => {
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '100', delivered: '97', failed: '3', queued: '7' },
      ],
      historyRows: [
        { id: '12', events: '28', delivered: '28', failed: '0' },
      ],
      queueRows: [{ id: '12', queued: '2' }],
    });

    const d = unwrap(await svc.integrationMetrics());

    expect(d.connections).toHaveLength(2);
    expect(d.totals).toEqual({ events: 128, failed: 3, queued: 9 });
  });

  it("TC12: ulanish yo'q -> bo'sh ro'yxat va nol jami (xato EMAS)", async () => {
    const d = unwrap(await makeSvc({}).integrationMetrics());

    expect(d.connections).toEqual([]);
    expect(d.totals).toEqual({ events: 0, failed: 0, queued: 0 });
  });
});
