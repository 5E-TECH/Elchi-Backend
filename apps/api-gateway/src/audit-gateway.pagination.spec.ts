import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AuditGatewayController } from './audit-gateway.controller';
import {
  ACTIVITY_FEED_OFFSET_CAP,
  compareFeedKeys,
  cursorTsOf,
  decodeFeedCursor,
  encodeFeedCursor,
  feedKeyOf,
  legBefore,
} from './audit/audit-feed-merge';

/**
 * 8eYmt4NV — `/activity-logs` ANIQ sahifalash (keyset + k-way merge).
 *
 * Servis legi soxtasi `ActivityLogService.query` semantikasini to'liq
 * takrorlaydi: filtrlar, `created_at DESC, id DESC`, ofset, `before_ts` /
 * `before_id` / `before_inclusive` keyset sharti, `keys_only`, `with_total`.
 * Vaqtlar ATAYLAB to'qnashadi: servislar orasida AYNI mikrosekund, bitta
 * millisekund ichida turli mikrosekundlar (JS Date ms ga kesilsa yo'qolardi).
 */
type Row = Record<string, any>;

const SERVICES = [
  'identity',
  'order',
  'finance',
  'branch',
  'integration',
  'logistics',
  'catalog',
  'investor',
  'notification',
] as const;

/** `2026-10-14T09:00:00.000000Z` + n mikrosekund (n katta — sekundlarga o'tadi). */
function tsPlusMicros(n: number): string {
  const base = Date.UTC(2026, 9, 1, 0, 0, 0);
  const ms = Math.floor(n / 1000);
  const us = n % 1000;
  return new Date(base + ms)
    .toISOString()
    .replace(/\.(\d{3})Z$/, `.$1${String(us).padStart(3, '0')}Z`);
}

function seedRows(
  count: number,
  opts: { step?: (i: number) => number; entityType?: (i: number) => string },
): Row[] {
  const rows: Row[] = [];
  let t = 0;
  for (let i = 1; i <= count; i++) {
    t += opts.step ? opts.step(i) : 1;
    const ts = tsPlusMicros(t);
    rows.push({
      id: String(i),
      entity_type: opts.entityType ? opts.entityType(i) : 'Order',
      entity_id: String(i),
      action: 'updated',
      cursor_ts: ts,
      created_at: new Date(Date.parse(ts)).toISOString(),
    });
  }
  return rows;
}

const idDesc = (a: Row, b: Row) =>
  b.cursor_ts > a.cursor_ts
    ? 1
    : b.cursor_ts < a.cursor_ts
      ? -1
      : Number(b.id) - Number(a.id);

/** `ActivityLogService.query` ning in-memory nusxasi (servis legi). */
function makeLeg(
  name: string,
  rows: Row[],
  opts: { fail?: boolean; ignoreCursor?: boolean } = {},
) {
  const calls: Row[] = [];
  const send = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd !== `${name}.activity_log.find_all`) {
      return of({ data: [] });
    }
    if (opts.fail) return throwError(() => new Error('timeout'));
    const q = payload?.query ?? {};
    calls.push(q);
    let list = rows
      .filter((r) => !q.entity_type || r.entity_type === q.entity_type)
      .filter((r) => !q.action || r.action === q.action)
      .sort(idDesc);
    const total = list.length;
    if (q.before_ts && !opts.ignoreCursor) {
      const bts = q.before_ts;
      if (q.before_id) {
        list = list.filter(
          (r) =>
            r.cursor_ts < bts ||
            (r.cursor_ts === bts && Number(r.id) < Number(q.before_id)),
        );
      } else if (q.before_inclusive) {
        list = list.filter((r) => r.cursor_ts <= bts);
      } else {
        list = list.filter((r) => r.cursor_ts < bts);
      }
    }
    const keysOnly = q.keys_only === true && !opts.ignoreCursor;
    const cap = keysOnly ? 10_100 : 500;
    const limit = Math.min(Number(q.limit ?? 50), cap);
    const page = Number(q.page ?? 1);
    const items = list
      .slice((page - 1) * limit, (page - 1) * limit + limit)
      .map((r) => (keysOnly ? { id: r.id, cursor_ts: r.cursor_ts } : r));
    return of({
      items,
      meta: {
        page,
        limit,
        total: q.with_total === false ? items.length : total,
      },
    });
  });
  return { send, calls };
}

function makeController(
  legs: Partial<Record<(typeof SERVICES)[number], ReturnType<typeof makeLeg>>>,
) {
  const empty = makeLeg('none', []);
  const clients = SERVICES.map((s) => legs[s] ?? makeLeg(s, []));
  const enrichment = {
    enrich: jest.fn((rows: Row[]) => Promise.resolve(rows)),
  };
  const controller = new AuditGatewayController(
    ...(clients as unknown as [
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
    ]),
    enrichment as never,
  );
  return { controller, clients, empty };
}

async function readAllPages(
  controller: AuditGatewayController,
  query: Row = {},
): Promise<{ rows: Row[]; metas: Row[] }> {
  const first = await controller.list({ ...query, page: 1, limit: 20 });
  const totalPages = first.data.meta.totalPages;
  const rows: Row[] = [...first.data.items];
  const metas: Row[] = [{ ...first.data.meta, count: first.data.items.length }];
  for (let p = 2; p <= totalPages; p++) {
    const res = await controller.list({ ...query, page: p, limit: 20 });
    metas.push({ ...res.data.meta, count: res.data.items.length });
    rows.push(...res.data.items);
  }
  return { rows, metas };
}

const rankOf = (svc: string) => SERVICES.indexOf(svc as never);
const globalKey = (r: Row) => feedKeyOf(r, rankOf(r._service));

describe('8eYmt4NV — audit-feed-merge yordamchilari', () => {
  it('cursorTsOf: servis cursor_ts (µs) ustun; bo`lmasa created_at ms → µs', () => {
    expect(
      cursorTsOf({
        cursor_ts: '2026-10-14T09:10:19.064123Z',
        created_at: 'x',
      }),
    ).toBe('2026-10-14T09:10:19.064123Z');
    expect(cursorTsOf({ created_at: '2026-10-14T09:10:19.064Z' })).toBe(
      '2026-10-14T09:10:19.064000Z',
    );
  });

  it('legBefore: rank > r0 → <=, rank < r0 → <, ayni servis → (ts,id) <', () => {
    const c = { ts: '2026-10-14T09:10:19.064123Z', rank: 2, id: '50' };
    expect(legBefore(c, 2)).toEqual({ before_ts: c.ts, before_id: '50' });
    expect(legBefore(c, 5)).toEqual({
      before_ts: c.ts,
      before_inclusive: true,
    });
    expect(legBefore(c, 0)).toEqual({
      before_ts: c.ts,
      before_inclusive: false,
    });
  });

  it('kursor kodlash/ochish; buzilgan kursor — null', () => {
    const key = { ts: '2026-10-14T09:10:19.064123Z', rank: 1, id: '77' };
    const enc = encodeFeedCursor(key, 'order');
    expect(decodeFeedCursor(enc, SERVICES)).toEqual(key);
    expect(decodeFeedCursor('bad!!', SERVICES)).toBeNull();
    expect(
      decodeFeedCursor(
        Buffer.from(JSON.stringify({ t: key.ts, s: 'nope', i: '1' })).toString(
          'base64url',
        ),
        SERVICES,
      ),
    ).toBeNull();
  });

  it('id solishtirish raqamli (bigint satr): "9" < "10"', () => {
    const a = { ts: 'T', rank: 0, id: '10' };
    const b = { ts: 'T', rank: 0, id: '9' };
    expect(compareFeedKeys(a, b)).toBeLessThan(0); // 10 yangiroq
  });
});

describe('8eYmt4NV — GET /activity-logs aniq sahifalash', () => {
  it('⭐ TC2: 3 soxta leg × 600 qator — 1..totalPages yig`indisi 1800, global tartib, dublikatsiz', async () => {
    // Vaqtlar to'qnashadi: identity har 1µs, order har 2µs, finance har 3µs →
    // ko'p qatorda servislar orasida AYNI mikrosekund.
    const identity = makeLeg('identity', seedRows(600, { step: () => 1 }));
    const order = makeLeg('order', seedRows(600, { step: () => 2 }));
    const finance = makeLeg('finance', seedRows(600, { step: () => 3 }));
    const { controller } = makeController({ identity, order, finance });

    const { rows, metas } = await readAllPages(controller);

    expect(metas[0].total).toBe(1800);
    expect(metas[0].totalPages).toBe(90);
    expect(rows).toHaveLength(1800);
    const ids = rows.map((r) => `${r._service}:${r.id}`);
    expect(new Set(ids).size).toBe(1800);
    // Global (cursor_ts DESC, servis, id DESC) tartib.
    for (let i = 1; i < rows.length; i++) {
      expect(
        compareFeedKeys(globalKey(rows[i - 1]), globalKey(rows[i])),
      ).toBeLessThan(0);
    }
    // TC4: meta.total = haqiqatan o'qilgan qatorlar.
    expect(metas.every((m) => m.total === rows.length)).toBe(true);
  });

  it('⭐ TC1: prod taqsimoti (3429 qator, 9 servis) — HAR page <= totalPages bo`sh emas (avval 90-dan bo`sh)', async () => {
    const counts: Record<string, number> = {
      identity: 2218,
      order: 617,
      finance: 279,
      branch: 84,
      integration: 29,
      logistics: 152,
      catalog: 25,
      investor: 3,
      notification: 22,
    };
    const legs = Object.fromEntries(
      Object.entries(counts).map(([svc, n], k) => [
        svc,
        makeLeg(svc, seedRows(n, { step: (i) => ((i * (k + 3)) % 7) + 1 })),
      ]),
    );
    const { controller } = makeController(legs);

    const { rows, metas } = await readAllPages(controller);

    expect(metas[0].total).toBe(3429);
    expect(metas[0].totalPages).toBe(172);
    const emptyPages = metas
      .map((m, i) => ({ page: i + 1, count: m.count }))
      .filter((p) => p.count === 0);
    expect(emptyPages).toEqual([]);
    const perPage = await Promise.all(
      [80, 90, 100, 171, 172].map((p) =>
        controller
          .list({ page: p, limit: 20 })
          .then((r) => r.data.items.length),
      ),
    );
    expect(perPage).toEqual([20, 20, 20, 20, 9]);
    expect(rows).toHaveLength(3429);
    expect(new Set(rows.map((r) => `${r._service}:${r.id}`)).size).toBe(3429);
  });

  it('⭐ TC3: ?service=identity, bitta legda 2200 qator — page=30 bo`sh emas (servis ofseti)', async () => {
    const identity = makeLeg('identity', seedRows(2200, {}));
    const { controller } = makeController({ identity });

    const res = await controller.list({
      service: 'identity',
      page: 30,
      limit: 20,
    });

    expect(res.data.items).toHaveLength(20);
    expect(res.data.meta).toMatchObject({ total: 2200, totalPages: 110 });
    const last = await controller.list({
      service: 'identity',
      page: 110,
      limit: 20,
    });
    expect(last.data.items).toHaveLength(20);
    expect(last.data.meta.next_cursor).toBeNull();
    // Bitta so'rov, servisning o'z ofseti (kalit fazasi yo'q).
    expect(identity.calls.at(-1)).toMatchObject({ page: 110, limit: 20 });
    expect(identity.calls.some((c) => c.keys_only)).toBe(false);
  });

  it('⭐ ?cursor= rejimi: next_cursor zanjiri butun lentani aniq beradi', async () => {
    const identity = makeLeg('identity', seedRows(300, { step: () => 1 }));
    const order = makeLeg('order', seedRows(250, { step: () => 1 }));
    const { controller } = makeController({ identity, order });

    const rows: Row[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const res = await controller.list({ limit: 37, cursor } as never);
      rows.push(...res.data.items);
      if (cursor) expect(res.data.meta.page).toBeNull();
      cursor = res.data.meta.next_cursor ?? undefined;
    } while (cursor && ++guard < 100);

    expect(rows).toHaveLength(550);
    expect(new Set(rows.map((r) => `${r._service}:${r.id}`)).size).toBe(550);
    // Sahifa rejimi bilan AYNI tartib.
    const paged = await readAllPages(controller);
    expect(rows.map((r) => `${r._service}:${r.id}`)).toEqual(
      paged.rows.map((r) => `${r._service}:${r.id}`),
    );
  });

  it('buzilgan cursor — 400', async () => {
    const { controller } = makeController({});
    await expect(
      controller.list({ cursor: 'garbage' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('chuqurlik chegarasi: jami > CAP bo`lsa meta.truncated, total = o`qiladigan, total_all = to`liq', async () => {
    const big = ACTIVITY_FEED_OFFSET_CAP + 500;
    const identity = makeLeg('identity', seedRows(big - 400, {}));
    const order = makeLeg('order', seedRows(400, { step: () => 7 }));
    const { controller } = makeController({ identity, order });

    const res = await controller.list({ page: 1, limit: 20 });
    expect(res.data.meta).toMatchObject({
      total: ACTIVITY_FEED_OFFSET_CAP,
      totalPages: ACTIVITY_FEED_OFFSET_CAP / 20,
      truncated: true,
      total_all: big,
    });
    const lastReadable = await controller.list({
      page: ACTIVITY_FEED_OFFSET_CAP / 20,
      limit: 20,
    });
    expect(lastReadable.data.items).toHaveLength(20);
    const beyond = await controller.list({
      page: ACTIVITY_FEED_OFFSET_CAP / 20 + 2,
      limit: 20,
    });
    expect(beyond.data.items).toHaveLength(0);
  });

  it('jtB0i4y3 TC4: entity_type=Settlement filtri har legga uzatiladi va faqat o`sha qatorlar qaytadi', async () => {
    const order = makeLeg(
      'order',
      seedRows(60, {
        entityType: (i) => (i % 3 === 0 ? 'Settlement' : 'Order'),
      }),
    );
    const finance = makeLeg('finance', seedRows(10, {}));
    const { controller } = makeController({ order, finance });

    const res = await controller.list({
      entity_type: 'Settlement',
      limit: 100,
    });

    expect(res.data.items).toHaveLength(20);
    expect(
      res.data.items.every((r: Row) => r.entity_type === 'Settlement'),
    ).toBe(true);
    expect(order.calls[0]).toMatchObject({ entity_type: 'Settlement' });
    expect(finance.calls[0]).toMatchObject({ entity_type: 'Settlement' });
  });

  it('y8CxCtcK: "Faqat kassa chiqimlari" (action=finance.manual_expense) — faqat o`sha fe`l', async () => {
    const rows = seedRows(30, {}).map((r, i) => ({
      ...r,
      action: i % 2 ? 'finance.manual_expense' : 'finance.manual_income',
    }));
    const finance = makeLeg('finance', rows);
    const { controller } = makeController({ finance });
    const res = await controller.list({
      action: 'finance.manual_expense',
      limit: 100,
    });
    expect(res.data.items).toHaveLength(15);
    expect(
      res.data.items.every((r: Row) => r.action === 'finance.manual_expense'),
    ).toBe(true);
  });

  it('javob bermagan servis — lenta yiqilmaydi, meta.failed_services', async () => {
    const identity = makeLeg('identity', seedRows(30, {}));
    const order = makeLeg('order', [], { fail: true });
    const { controller } = makeController({ identity, order });
    const res = await controller.list({ page: 2, limit: 10 });
    expect(res.data.items).toHaveLength(10);
    expect(res.data.meta.failed_services).toEqual(['order']);
  });

  it('deploy oralig`i: eski servis (keyset parametrlarini bilmaydi) — kursor lentasi yiqilmaydi, dublikatsiz', async () => {
    // Gateway yangi, servis eski: servis before_*/keys_only ni e'tiborsiz
    // qoldiradi. Gateway qatorlarni o'zi ham kursor bo'yicha kesadi.
    const identity = makeLeg('identity', seedRows(50, {}));
    const order = makeLeg('order', seedRows(50, { step: () => 2 }), {
      ignoreCursor: true,
    });
    const { controller } = makeController({ identity, order });
    const rows: Row[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const res = await controller.list({ limit: 10, cursor } as never);
      rows.push(...res.data.items);
      cursor = res.data.meta.next_cursor ?? undefined;
    } while (cursor && ++guard < 50);
    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect(new Set(rows.map((r) => `${r._service}:${r.id}`)).size).toBe(
      rows.length,
    );
  });
});

describe('y8CxCtcK — GET /activity-logs/actions reyestrdan', () => {
  it('⭐ data string[] (orqaga mos) va ichida finance.manual_expense, order.sell, investor.profit_calculated', () => {
    const { controller } = makeController({});
    const res = controller.actions();
    expect(res.data.every((a) => typeof a === 'string')).toBe(true);
    expect(res.data).toEqual(
      expect.arrayContaining([
        'finance.manual_expense',
        'order.sell',
        'investor.profit_calculated',
        'status_change',
      ]),
    );
    expect(res.data.length).toBeGreaterThan(16);
    const expense = res.registry.find(
      (r) => r.action === 'finance.manual_expense',
    );
    expect(expense).toMatchObject({
      label: "Qo'lda chiqim",
      category: 'finance',
      category_label: 'Moliya',
      icon: 'minus',
      tone: 'rose',
    });
    expect(res.categories.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        'Buyurtma',
        'Moliya',
        'Kirish',
        'Filial',
        'Integratsiya',
        'Logistika',
      ]),
    );
  });
});
