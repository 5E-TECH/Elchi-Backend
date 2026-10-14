import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogService } from './activity-log.service';
import { quoteActivityLogTable } from './retention';

/**
 * HAQIQIY POSTGRES testi (8eYmt4NV — keyset kursor) — FAQAT
 * `ACTIVITY_PG_TEST_URI` berilganda ishlaydi (oddiy `jest` da skip):
 *
 *   ACTIVITY_PG_TEST_URI=postgres://postgres@localhost:55463/spec \
 *     npx jest libs/common/src/activity-log/activity-log.cursor.pg.spec.ts --runInBand
 *
 * Bir millisekund ichida turli mikrosekundli qatorlar va AYNI created_at li
 * qatorlar: `cursor_ts` + `(created_at, id)` keyset'i hech birini
 * yo'qotmasligi va takrorlamasligi kerak.
 */
const PG_URI = process.env.ACTIVITY_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

describePg('activity_logs keyset kursor — real Postgres (8eYmt4NV)', () => {
  let ds: DataSource;
  let service: ActivityLogService;
  const schema = `spec_cur_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const table = quoteActivityLogTable(schema);

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema,
      entities: [ActivityLog],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query(`CREATE SCHEMA "${schema}"`);
    await ds.synchronize();
    service = new ActivityLogService(
      ds.getRepository(ActivityLog),
      'order-service',
    );
    // 300 qator: har 3 tasi AYNI mikrosekundda, ketma-ket guruhlar 1µs farq —
    // ya'ni 1 ms ichida ~1000 qator (JS Date ms ga kesilsa to'qnashardi).
    await ds.query(
      `INSERT INTO ${table} (entity_type, entity_id, action, created_at)
       SELECT CASE WHEN g % 5 = 0 THEN 'Settlement' ELSE 'Order' END,
              g::text, 'updated',
              timestamptz '2026-10-14 09:10:19.064000+00'
                + make_interval(secs => (g / 3) * 0.000001)
         FROM generate_series(1, 300) AS g`,
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ds.destroy();
  });

  it('cursor_ts — mikrosekundli UTC satr, created_at bilan mos', async () => {
    const page = await service.query({ limit: 3, with_total: true });
    const items = page.items as Array<ActivityLog & { cursor_ts: string }>;
    expect(items[0].cursor_ts).toBe('2026-10-14T09:10:19.064100Z');
    expect(items.every((r) => /\.\d{6}Z$/.test(r.cursor_ts))).toBe(true);
    expect(page.meta.total).toBe(300);
  });

  it('⭐ (created_at, id) keyset — 7 talik sahifalar bilan butun jadval, dublikatsiz va yo`qotishsiz', async () => {
    const seen: string[] = [];
    let before: { ts: string; id: string } | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const res = await service.query({
        limit: 7,
        with_total: false,
        ...(before ? { before_ts: before.ts, before_id: before.id } : {}),
      });
      const items = res.items as Array<ActivityLog & { cursor_ts: string }>;
      if (!items.length) break;
      seen.push(...items.map((r) => String(r.id)));
      const last = items[items.length - 1];
      before = { ts: last.cursor_ts, id: String(last.id) };
    }
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
    // Ofset yo'li bilan AYNI tartib.
    const all = await service.query({ limit: 300 });
    expect(seen).toEqual(all.items.map((r) => String(r.id)));
  });

  it('before_inclusive: AYNI mikrosekunddagi qatorlar <= da bor, < da yo`q', async () => {
    const ts = '2026-10-14T09:10:19.064050Z'; // g = 150, 151, 152
    const incl = await service.query({
      before_ts: ts,
      before_inclusive: true,
      limit: 3,
      with_total: false,
    });
    const excl = await service.query({
      before_ts: ts,
      before_inclusive: false,
      limit: 3,
      with_total: false,
    });
    expect(incl.items.map((r) => r.entity_id)).toEqual(['152', '151', '150']);
    expect(excl.items.map((r) => r.entity_id)).toEqual(['149', '148', '147']);
  });

  it('keys_only + filtr: faqat id/cursor_ts, jami filtr bo`yicha', async () => {
    const res = await service.query({
      entity_type: 'Settlement',
      keys_only: true,
      with_total: true,
      limit: 1000,
    });
    expect(res.meta.total).toBe(60);
    expect(res.items).toHaveLength(60);
    expect(Object.keys(res.items[0]).sort()).toEqual(['cursor_ts', 'id']);
  });
});
