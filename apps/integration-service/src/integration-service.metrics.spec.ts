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
  /** 6qfzLBcR — `external_integrations` (id, role, inbound_status_mapping). */
  integrations?: any[];
  shipmentRows?: any[];
  partnerShipmentRows?: any[];
  webhookRows?: any[];
  receivableRows?: any[];
  remittanceRows?: any[];
}) {
  /** Har `createQueryBuilder()` chaqiruvi — o'z builder'i (SQL va parametrlarni o'qish uchun). */
  const builders: Record<string, any[]> = {};
  const qb = (name: string, rows: any[]) => {
    const b: any = { sql: [] as string[], params: {} as Record<string, any> };
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
      b[m] = jest.fn((sql: string, params?: Record<string, any>) => {
        b.sql.push(sql);
        Object.assign(b.params, params ?? {});
        return b;
      });
    }
    b.setParameter = jest.fn((key: string, value: any) => {
      b.params[key] = value;
      return b;
    });
    b.setParameters = jest.fn((params: Record<string, any>) => {
      Object.assign(b.params, params);
      return b;
    });
    b.getRawMany = jest.fn(() => Promise.resolve(rows));
    (builders[name] ??= []).push(b);
    return b;
  };
  const repo = (name: string, rows?: any[]) => ({
    createQueryBuilder: jest.fn(() => qb(name, rows ?? [])),
  });

  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.partnerWebhookOutboxRepo = repo('outbox', opts.partnerRows);
  svc.syncHistoryRepo = repo('history', opts.historyRows);
  svc.syncQueueRepo = repo('queue', opts.queueRows);
  svc.integrationRepo = {
    find: jest.fn(() => Promise.resolve(opts.integrations ?? [])),
  };
  svc.shipmentRepo = repo('shipments', opts.shipmentRows);
  svc.partnerShipmentRefRepo = repo(
    'partnerShipments',
    opts.partnerShipmentRows,
  );
  svc.webhookLogRepo = repo('webhooks', opts.webhookRows);
  svc.receivableRepo = repo('receivables', opts.receivableRows);
  svc.remittanceRepo = repo('remittances', opts.remittanceRows);
  svc.builders = builders;
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
    expect(
      unwrap(await svc.integrationMetrics()).connections[0].success_rate,
    ).toBe(90);
  });

  it("TC5: ⭐ yakunlangan hodisa YO'Q -> foiz `null` (0% EMAS)", async () => {
    // 0% "hammasi yiqildi" degan yolg'on xabar bo'lardi.
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '5', delivered: '0', failed: '0', queued: '5' },
      ],
    });

    expect(
      unwrap(await svc.integrationMetrics()).connections[0].success_rate,
    ).toBeNull();
  });

  it("TC6: ⭐ javob vaqti o'lchanmagan -> `null` (0 EMAS)", async () => {
    // 0 ms "bir zumda javob berdi" degan yolg'on bo'lardi.
    const svc = makeSvc({
      partnerRows: [
        {
          id: '7',
          events: '2',
          delivered: '2',
          failed: '0',
          queued: '0',
          avg_ms: null,
        },
      ],
    });

    expect(
      unwrap(await svc.integrationMetrics()).connections[0].avg_ms,
    ).toBeNull();
  });

  it("TC7: hodisa yo'q -> last_event_at `null`", async () => {
    const svc = makeSvc({
      partnerRows: [
        {
          id: '7',
          events: '0',
          delivered: '0',
          failed: '0',
          queued: '0',
          last_at: null,
        },
      ],
    });

    expect(
      unwrap(await svc.integrationMetrics()).connections[0].last_event_at,
    ).toBeNull();
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

    expect(unwrap(await svc.integrationMetrics()).connections[0].queued).toBe(
      0,
    );
  });

  it('TC10: ⭐ outbound javob vaqti HAMISHA `null`', async () => {
    // `sync_history` da bunday ustun yo'q. 0 yozish yolg'on bo'lardi.
    const svc = makeSvc({
      historyRows: [{ id: '12', events: '3', delivered: '3', failed: '0' }],
    });

    expect(
      unwrap(await svc.integrationMetrics()).connections[0].avg_ms,
    ).toBeNull();
  });
});

describe('integrationMetrics — jami', () => {
  it('TC11: ikki manba jami bo‘yicha qo‘shiladi', async () => {
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '100', delivered: '97', failed: '3', queued: '7' },
      ],
      historyRows: [{ id: '12', events: '28', delivered: '28', failed: '0' }],
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

/**
 * 6qfzLBcR — «Umumiy holat»: har ulanishda posilka, kiruvchi webhook va COD
 * bloklari. Asosiy qulf o'sha-o'sha: O'LCHANMAGAN qiymat `null`, 0 EMAS.
 */
describe('integrationMetrics — posilka / webhook / COD bloklari (6qfzLBcR)', () => {
  const carrier = (id = '12', mapping: any = null) => ({
    id,
    role: 'carrier',
    inbound_status_mapping: mapping,
  });
  const integrationOf = (d: any, id = '12') =>
    d.connections.find((c: any) => c.uid === `integration:${id}`);

  it('TC13: tashuvchi posilkalari — jami / yetkazildi / yiqilgan / nomuvofiqlik', async () => {
    const svc = makeSvc({
      integrations: [
        carrier('12', { delivered: { status: 'sold', action: 'sell' } }),
      ],
      historyRows: [{ id: '12', events: '5', delivered: '5', failed: '0' }],
      shipmentRows: [
        {
          id: '12',
          total: '40',
          delivered: '31',
          failed: '2',
          mismatch: '3',
        },
      ],
    });

    const c = integrationOf(unwrap(await svc.integrationMetrics()));

    expect(c.shipments).toEqual({
      total: 40,
      delivered: 31,
      failed: 2,
      mismatch: 3,
    });
    // Nomuvofiqlik — ulanishning normallashgan xaritasi bilan (kalit katta harf).
    const shipmentsQb = svc.builders.shipments[0];
    expect(JSON.parse(shipmentsQb.params.status_maps)).toEqual({
      '12': { DELIVERED: 'sold' },
    });
    expect(shipmentsQb.params.delivered).toEqual([
      'sold',
      'paid',
      'partly_paid',
      'closed',
    ]);
  });

  it("TC14: ⭐ status xaritasi bo'sh -> `mismatch: null` (0 EMAS)", async () => {
    // Xaritasiz har qator "nomuvofiq" bo'lib chiqardi — raqam umuman berilmaydi.
    const svc = makeSvc({
      integrations: [carrier('12', {})],
      shipmentRows: [
        { id: '12', total: '4', delivered: '1', failed: '0', mismatch: '0' },
      ],
    });

    const c = integrationOf(unwrap(await svc.integrationMetrics()));

    expect(c.shipments.mismatch).toBeNull();
    expect(c.shipments.total).toBe(4);
    expect(JSON.parse(svc.builders.shipments[0].params.status_maps)).toEqual(
      {},
    );
  });

  it('TC15: kiruvchi webhooklar — Hodisalar pillari bilan bir xil holatlar', async () => {
    const svc = makeSvc({
      integrations: [carrier()],
      historyRows: [{ id: '12', events: '1', delivered: '1', failed: '0' }],
      webhookRows: [
        { id: '12', success: '120', failed: '4', invalid_signature: '3' },
      ],
    });

    const c = integrationOf(unwrap(await svc.integrationMetrics()));

    expect(c.webhooks).toEqual({
      success: 120,
      failed: 4,
      invalid_signature: 3,
    });
    const sql = svc.builders.webhooks[0].sql.join(' ');
    expect(sql).toContain("wl.status = 'processed'");
    expect(sql).toContain("wl.status IN ('rejected','failed')");
    expect(sql).toContain('wl.signature_valid = false');
  });

  it("TC16: oynada webhook kelmagan integratsiya -> 0 (o'lchangan, `null` emas)", async () => {
    // Jurnal har kiruvchi so'rovni yozadi — qator yo'qligi "kelmadi" degani.
    const svc = makeSvc({
      integrations: [carrier()],
      historyRows: [{ id: '12', events: '1', delivered: '1', failed: '0' }],
    });

    const c = integrationOf(unwrap(await svc.integrationMetrics()));

    expect(c.webhooks).toEqual({ success: 0, failed: 0, invalid_signature: 0 });
  });

  it("TC17: ⭐ COD — faqat qarz daftari va to'lovlardan; `dispatched` HAR DOIM `null`", async () => {
    const svc = makeSvc({
      integrations: [carrier()],
      historyRows: [{ id: '12', events: '1', delivered: '1', failed: '0' }],
      receivableRows: [
        { id: '12', collected: '9000000.00', debt: '5000000.00' },
      ],
      remittanceRows: [{ id: '12', remitted: '4000000.00' }],
    });

    const c = integrationOf(unwrap(await svc.integrationMetrics()));

    // Jo'natilgan COD daftarda yozilmaydi — 0 emas, `null`.
    expect(c.cod).toEqual({
      dispatched: null,
      collected: 9_000_000,
      remitted: 4_000_000,
      debt: 5_000_000,
    });
  });

  it("TC18: ⭐ qarz = Hisob-kitob qoldig'i (PENDING), yig'ilgan bekorlarsiz", async () => {
    const svc = makeSvc({ integrations: [carrier()] });
    await svc.integrationMetrics();

    const receivableQb = svc.builders.receivables[0];
    const sql = receivableQb.sql.join(' ');
    expect(sql).toContain('r.status = :pending');
    expect(sql).toContain('r.status IN (:...collected)');
    expect(sql).toContain('r.is_deleted = false');
    expect(receivableQb.params.pending).toBe('pending');
    expect(receivableQb.params.collected).toEqual(['pending', 'settled']);

    // To'lov — faqat FAOL (bekor qilingani kirmaydi).
    const remittanceQb = svc.builders.remittances[0];
    expect(remittanceQb.sql.join(' ')).toContain('m.status = :active');
    expect(remittanceQb.params.active).toBe('active');
  });

  it("TC19: tashuvchida daftar bo'sh -> COD 0 (o'lchangan), qarz yo'q", async () => {
    const svc = makeSvc({
      integrations: [carrier()],
      historyRows: [{ id: '12', events: '1', delivered: '1', failed: '0' }],
    });

    expect(integrationOf(unwrap(await svc.integrationMetrics())).cod).toEqual({
      dispatched: null,
      collected: 0,
      remitted: 0,
      debt: 0,
    });
  });

  it("TC20: ⭐ rol bo'yicha: manba — COD `null`; to'lov / ko'zgu — posilka ham `null`", async () => {
    const history = (id: string) => ({
      id,
      events: '1',
      delivered: '1',
      failed: '0',
    });
    const svc = makeSvc({
      integrations: [
        { id: '20', role: 'source', inbound_status_mapping: null },
        { id: '21', role: 'payment', inbound_status_mapping: null },
        { id: '22', role: 'mirror', inbound_status_mapping: null },
      ],
      historyRows: [history('20'), history('21'), history('22')],
    });

    const d = unwrap(await svc.integrationMetrics());

    expect(integrationOf(d, '20').cod).toBeNull();
    expect(integrationOf(d, '20').shipments).toEqual({
      total: 0,
      delivered: 0,
      failed: 0,
      mismatch: null,
    });
    for (const id of ['21', '22']) {
      expect(integrationOf(d, id).shipments).toBeNull();
      expect(integrationOf(d, id).cod).toBeNull();
      // Kiruvchi jurnal har ulanishda o'lchanadi.
      expect(integrationOf(d, id).webhooks).toEqual({
        success: 0,
        failed: 0,
        invalid_signature: 0,
      });
    }
  });

  it("TC21: ⭐ hamkor — faqat posilka soni; holati va COD o'lchanmaydi (`null`)", async () => {
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '10', delivered: '8', failed: '1', queued: '1' },
      ],
      partnerShipmentRows: [{ id: '7', total: '6' }],
    });

    const c = unwrap(await svc.integrationMetrics()).connections[0];

    expect(c.uid).toBe('partner:7');
    // Holat buyurtmaning o'zida (boshqa sxema) — sanab bo'lmaydi, 0 deyilmaydi.
    expect(c.shipments).toEqual({
      total: 6,
      delivered: null,
      failed: null,
      mismatch: null,
    });
    // Webhookni BIZ yuboramiz — imzoni ular tekshiradi.
    expect(c.webhooks).toEqual({
      success: 8,
      failed: 1,
      invalid_signature: null,
    });
    expect(c.cod).toBeNull();
  });

  it("TC22: hamkorda oynada posilka yo'q -> `total: 0`", async () => {
    const svc = makeSvc({
      partnerRows: [
        { id: '7', events: '2', delivered: '2', failed: '0', queued: '0' },
      ],
    });

    expect(
      unwrap(await svc.integrationMetrics()).connections[0].shipments.total,
    ).toBe(0);
  });

  it("TC23: ⭐ hodisasiz, lekin posilka / COD qatori bor ulanish ro'yxatda", async () => {
    // Ilgari faqat hodisasi bor ulanish chiqardi — bloklar bo'sh qolardi.
    const svc = makeSvc({
      integrations: [carrier('12'), carrier('13')],
      shipmentRows: [
        { id: '12', total: '3', delivered: '0', failed: '1', mismatch: '0' },
      ],
      receivableRows: [{ id: '13', collected: '250000.00', debt: '250000.00' }],
      partnerShipmentRows: [{ id: '7', total: '2' }],
    });

    const d = unwrap(await svc.integrationMetrics());

    expect(d.connections.map((c: any) => c.uid)).toEqual([
      'partner:7',
      'integration:12',
      'integration:13',
    ]);
    const c12 = integrationOf(d, '12');
    expect(c12.events).toBe(0);
    expect(c12.success_rate).toBeNull();
    expect(c12.last_event_at).toBeNull();
    expect(c12.shipments.total).toBe(3);
    expect(integrationOf(d, '13').cod.debt).toBe(250_000);
    expect(d.totals).toEqual({ events: 0, failed: 0, queued: 0 });
  });

  it("TC24: hech bir manbada qatori yo'q ulanish ro'yxatga kirmaydi", async () => {
    const d = unwrap(
      await makeSvc({ integrations: [carrier('12')] }).integrationMetrics(),
    );

    expect(d.connections).toEqual([]);
  });

  it('TC25: ⭐ oyna — posilka va webhook oynada, COD butun vaqt', async () => {
    const svc = makeSvc({});
    await svc.integrationMetrics(6);

    const since = (name: string) => svc.builders[name][0].params.since;
    const expected = since('shipments');
    expect(expected).toBeInstanceOf(Date);
    const ageHours = (Date.now() - expected.getTime()) / 3600_000;
    expect(ageHours).toBeGreaterThan(5.9);
    expect(ageHours).toBeLessThan(6.1);
    // Posilka: oynada yaratilgan YOKI holati o'zgargan.
    expect(svc.builders.shipments[0].sql.join(' ')).toContain(
      '(s."createdAt" >= :since OR s.status_changed_at >= :since)',
    );
    expect(since('partnerShipments')).toBe(expected);
    expect(since('webhooks')).toBe(expected);
    // COD davr bilan kesilmaydi.
    expect(since('receivables')).toBeUndefined();
    expect(since('remittances')).toBeUndefined();
  });

  it('TC26: navbatdagi, lekin tarixsiz integratsiya ham hisoblanadi', async () => {
    const svc = makeSvc({
      integrations: [carrier('12')],
      queueRows: [{ id: '12', queued: '5' }],
    });

    const d = unwrap(await svc.integrationMetrics());

    expect(integrationOf(d, '12').queued).toBe(5);
    expect(d.totals.queued).toBe(5);
  });
});
