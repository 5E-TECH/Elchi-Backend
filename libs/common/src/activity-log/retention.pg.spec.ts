import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogService } from './activity-log.service';
import {
  ACTIVITY_LOG_DEVICE_RETENTION_ENV,
  buildActivityLogPruneCountSql,
  buildDeviceMetadataCountSql,
  pruneActivityLogsBatched,
  quoteActivityLogTable,
  stripDeviceMetadataBatched,
} from './retention';

/**
 * HAQIQIY POSTGRES testi (f2Ud5tju DIQQAT — ip/qurilma qisqa muddati) —
 * FAQAT `ACTIVITY_PG_TEST_URI` berilganda ishlaydi (oddiy `jest` da skip):
 *
 *   ACTIVITY_PG_TEST_URI=postgres://user:pass@localhost:5432/test_db \
 *     npx jest libs/common/src/activity-log/retention.pg.spec.ts --runInBand
 *
 * Mavjud jadvallarga TEGMAYDI: alohida vaqtinchalik sxemada `ActivityLog`
 * entity'sidan jadval quriladi, oxirida DROP SCHEMA.
 */
const PG_URI = process.env.ACTIVITY_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

const DAY = 86_400_000;
const DEVICE = {
  ip: '203.0.113.7',
  user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0',
  device_id: 'dev-123',
  device_name: 'Telefon · Android · Chrome',
};

describePg('activity_logs ip/qurilma retention — real Postgres', () => {
  let ds: DataSource;
  const schema = `spec_ret_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const table = quoteActivityLogTable(schema);

  type Seed = {
    tag: string;
    ageDays: number;
    metadata: unknown;
    new_value?: unknown;
  };

  const insert = async (rows: Seed[]) => {
    for (const r of rows) {
      await ds.query(
        `INSERT INTO ${table}
           (entity_type, entity_id, action, metadata, new_value, created_at)
         VALUES ('Spec', $1, 'x', $2::jsonb, $3::jsonb, now() - make_interval(secs => $4))`,
        [
          r.tag,
          r.metadata === null ? null : JSON.stringify(r.metadata),
          r.new_value === undefined ? null : JSON.stringify(r.new_value),
          (r.ageDays * DAY) / 1000,
        ],
      );
    }
  };

  const byTag = async () => {
    const rows: Array<{
      entity_id: string;
      metadata: Record<string, unknown> | null;
      new_value: Record<string, unknown> | null;
      xmin: string;
    }> = await ds.query(
      `SELECT entity_id, metadata, new_value, xmin::text AS xmin FROM ${table}`,
    );
    return new Map(rows.map((r) => [r.entity_id, r]));
  };

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
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query(`TRUNCATE ${table} RESTART IDENTITY`);
  });

  it('FAQAT eski qatorlar va FAQAT 4 kalit; boshqa kalit/ustun/qator qoladi', async () => {
    await insert([
      {
        tag: 'old-mixed',
        ageDays: 40,
        metadata: { ...DEVICE, market_id: '501', reason: 'bad_password' },
      },
      { tag: 'old-device-only', ageDays: 40, metadata: { ip: '1.2.3.4' } },
      { tag: 'fresh', ageDays: 5, metadata: { ...DEVICE, market_id: '7' } },
      { tag: 'old-null', ageDays: 40, metadata: null },
      { tag: 'old-no-device', ageDays: 40, metadata: { market_id: '9' } },
      { tag: 'old-array', ageDays: 40, metadata: ['ip'] },
      {
        tag: 'old-new-value',
        ageDays: 40,
        metadata: { device_id: 'd1' },
        new_value: { ip: 'keep-me' },
      },
    ]);
    const before = await byTag();

    const stripped = await stripDeviceMetadataBatched(
      (sql, params) => ds.query(sql, params),
      table,
      new Date(Date.now() - 30 * DAY),
      100,
    );

    expect(stripped).toBe(3);
    const after = await byTag();
    expect(after.size).toBe(7); // qatorlar o'chirilmaydi
    expect(after.get('old-mixed')!.metadata).toEqual({
      market_id: '501',
      reason: 'bad_password',
    });
    expect(after.get('old-device-only')!.metadata).toEqual({});
    expect(after.get('old-new-value')!.metadata).toEqual({});
    // faqat metadata ustuni — new_value dagi `ip` qoladi
    expect(after.get('old-new-value')!.new_value).toEqual({ ip: 'keep-me' });
    // yangi qator TEGILMAGAN
    expect(after.get('fresh')!.metadata).toEqual({ ...DEVICE, market_id: '7' });
    // tegishli bo'lmagan qatorlarga UPDATE umuman yozilmagan (xmin o'zgarmagan)
    for (const tag of ['fresh', 'old-null', 'old-no-device', 'old-array']) {
      expect(after.get(tag)!.xmin).toBe(before.get(tag)!.xmin);
    }
    expect(after.get('old-array')!.metadata).toEqual(['ip']);
  });

  it('partiyalab: batch`dan ko`p qator bir necha so`rovda, qayta ishga tushirish 0', async () => {
    await insert(
      Array.from({ length: 23 }, (_, i) => ({
        tag: `old-${i}`,
        ageDays: 31 + i,
        metadata: { ...DEVICE, n: i },
      })),
    );
    const run = jest.fn((sql: string, params: unknown[]) =>
      ds.query(sql, params),
    );
    const cutoff = new Date(Date.now() - 30 * DAY);

    await expect(
      stripDeviceMetadataBatched(run, table, cutoff, 10),
    ).resolves.toBe(23);
    expect(run).toHaveBeenCalledTimes(3); // 10 + 10 + 3

    const [{ count }] = await ds.query(buildDeviceMetadataCountSql(table), [
      cutoff,
    ]);
    expect(Number(count)).toBe(0);
    const rows = await byTag();
    expect(rows.get('old-0')!.metadata).toEqual({ n: 0 });
    expect(rows.get('old-22')!.metadata).toEqual({ n: 22 });

    await expect(
      stripDeviceMetadataBatched(run, table, cutoff, 10),
    ).resolves.toBe(0);
  });

  // f2Ud5tju topilmasi (prune-delete-count): haqiqiy TypeORM `ds.query()`
  // top-level DELETE uchun `[rows, rowCount]` qaytaradi — eski skript `.length`
  // (= 2) ni son deb olib, birinchi partiyadan keyin to'xtardi.
  it('ildiz sabab: eski skript DELETE so`rovi — `.length` 2, 10 ta o`chgan bo`lsa ham', async () => {
    await insert(
      Array.from({ length: 23 }, (_, i) => ({
        tag: `expired-${i}`,
        ageDays: 400 + i,
        metadata: null,
      })),
    );
    const legacy: unknown[] = await ds.query(
      `DELETE FROM ${table}
           WHERE id IN (
             SELECT id FROM ${table}
             WHERE created_at < now() - interval '365 days'
             ORDER BY id
             LIMIT 10
           )
           RETURNING 1`,
    );
    expect(legacy).toHaveLength(2); // eski skript log'i: "deleted 2"
    expect(legacy[1]).toBe(10);
    expect((await byTag()).size).toBe(13);
  });

  it('prune skripti: batch`dan ko`p eski qator — HAMMASI o`chadi, son aniq; keyin strip ishlaydi', async () => {
    await insert([
      ...Array.from({ length: 23 }, (_, i) => ({
        tag: `expired-${i}`,
        ageDays: 400 + i,
        metadata: { ...DEVICE, n: i },
      })),
      { tag: 'old', ageDays: 40, metadata: { ...DEVICE, market_id: '1' } },
      { tag: 'fresh', ageDays: 5, metadata: { ...DEVICE } },
    ]);
    const run = jest.fn((sql: string, params: unknown[]) =>
      ds.query(sql, params),
    );
    const countExpired = async () => {
      const [{ count }]: Array<{ count: string }> = await ds.query(
        buildActivityLogPruneCountSql(table),
        [365],
      );
      return Number(count);
    };

    // --dry-run: o'chiriladiganlar soni, hech narsa o'zgarmaydi
    await expect(countExpired()).resolves.toBe(23);
    expect((await byTag()).size).toBe(25);

    await expect(pruneActivityLogsBatched(run, table, 365, 10)).resolves.toBe(
      23,
    );
    expect(run).toHaveBeenCalledTimes(3); // 10 + 10 + 3
    await expect(countExpired()).resolves.toBe(0);

    // skript tartibi: DELETE dan keyin ip/qurilma strip
    await expect(
      stripDeviceMetadataBatched(
        run,
        table,
        new Date(Date.now() - 30 * DAY),
        10,
      ),
    ).resolves.toBe(1);
    const rows = await byTag();
    expect([...rows.keys()].sort()).toEqual(['fresh', 'old']);
    expect(rows.get('old')!.metadata).toEqual({ market_id: '1' });
    expect(rows.get('fresh')!.metadata).toEqual(DEVICE);

    // qayta ishga tushirish — 0, bitta so'rov
    run.mockClear();
    await expect(pruneActivityLogsBatched(run, table, 365, 10)).resolves.toBe(
      0,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ActivityLogService.prune: umumiy muddat DELETE, env muddati tozalaydi', async () => {
    const saved = process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV];
    process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV] = '30';
    try {
      await insert([
        { tag: 'expired', ageDays: 100, metadata: { ...DEVICE } },
        { tag: 'old', ageDays: 40, metadata: { ...DEVICE, market_id: '1' } },
        { tag: 'fresh', ageDays: 5, metadata: { ...DEVICE } },
      ]);
      const service = new ActivityLogService(
        ds.getRepository(ActivityLog),
        'spec',
      );

      await expect(service.prune(90 * DAY)).resolves.toBe(1);

      const rows = await byTag();
      expect([...rows.keys()].sort()).toEqual(['fresh', 'old']);
      expect(rows.get('old')!.metadata).toEqual({ market_id: '1' });
      expect(rows.get('fresh')!.metadata).toEqual(DEVICE);
    } finally {
      if (saved === undefined)
        delete process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV];
      else process.env[ACTIVITY_LOG_DEVICE_RETENTION_ENV] = saved;
    }
  });
});
