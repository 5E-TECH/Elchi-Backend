import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateActivityLogsTables1714800000000 } from '../../../../migrations/1714800000000-CreateActivityLogsTables';
import { CreateActivityLogsInIntegrationSchema1715000000000 } from '../../../../migrations/1715000000000-CreateActivityLogsInIntegrationSchema';
import { ExtendActivityLogsCoverage1716000000009 } from '../../../../migrations/1716000000009-ExtendActivityLogsCoverage';
import { CreateAiSchema1716000000047 } from '../../../../migrations/1716000000047-CreateAiSchema';
import {
  ACTIVITY_LOG_DESCRIPTION_SCHEMAS,
  AddActivityLogDescription1716000000062,
} from '../../../../migrations/1716000000062-AddActivityLogDescription';
import { ActivityDescribeUz } from './describe-uz';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogService } from './activity-log.service';

/**
 * HAQIQIY POSTGRES testi (2WRzdWpZ TC1/TC7/TC10/TC11) — FAQAT
 * `ACTIVITY_PG_TEST_URI` berilganda ishlaydi (CI va oddiy `jest` da skip):
 *
 *   ACTIVITY_PG_TEST_URI=postgres://user:pass@localhost:5432/test_db \
 *     npx jest libs/common/src/activity-log/activity-log.description.pg.spec.ts --runInBand
 *
 * ⚠️ FAQAT TEST BAZASIDA. Audit jadvallari bo'lmasa oldingi migratsiyalar
 * `up()` qilinadi; TC10 `down()` → `up()` aylanishini bajaradi (oxirida ustun
 * va indeks QAYTA tiklanadi). Yozilgan qatorlar tasodifiy trace_id bilan
 * belgilanadi va o'chiriladi; 100k qatorli o'lchov alohida vaqtinchalik
 * sxemada, oxirida DROP SCHEMA.
 */
const PG_URI = process.env.ACTIVITY_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

describePg('activity_logs.description — real Postgres', () => {
  let ds: DataSource;
  const marker = `pg-spec-${randomUUID()}`.slice(0, 64);
  const benchSchema = `spec_desc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const withRunner = async (fn: (qr: QueryRunner) => Promise<void>) => {
    const qr = ds.createQueryRunner();
    try {
      await fn(qr);
    } finally {
      await qr.release();
    }
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema: 'order_schema',
      entities: [ActivityLog],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    const probe = await ds.query<
      Array<{ order: string | null; ai: string | null }>
    >(
      `SELECT to_regclass('order_schema.activity_logs') AS "order",
              to_regclass('ai_schema.activity_logs') AS ai`,
    );
    await withRunner(async (qr) => {
      if (!probe[0]?.order) {
        await new CreateActivityLogsTables1714800000000().up(qr);
        await new CreateActivityLogsInIntegrationSchema1715000000000().up(qr);
        await new ExtendActivityLogsCoverage1716000000009().up(qr);
      }
      if (!probe[0]?.ai) await new CreateAiSchema1716000000047().up(qr);
      await new AddActivityLogDescription1716000000062().up(qr);
    });
  }, 60_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(
      `DELETE FROM order_schema.activity_logs WHERE trace_id = $1`,
      [marker],
    );
    await ds.query(`DROP SCHEMA IF EXISTS "${benchSchema}" CASCADE`);
    await ds.destroy();
  });

  const columnInfo = () =>
    ds.query<
      Array<{ table_schema: string; data_type: string; is_nullable: string }>
    >(
      `SELECT table_schema, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'activity_logs' AND column_name = 'description'
          AND table_schema = ANY($1::text[])`,
      [ACTIVITY_LOG_DESCRIPTION_SCHEMAS],
    );

  it('TC1 har audit sxemasida description TEXT NULL + trgm indeks', async () => {
    const cols = await columnInfo();
    expect(cols.map((c) => c.table_schema).sort()).toEqual(
      [...ACTIVITY_LOG_DESCRIPTION_SCHEMAS].sort(),
    );
    for (const col of cols) {
      expect(col).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    }
    const idx = await ds.query<Array<{ schemaname: string; indexdef: string }>>(
      `SELECT schemaname, indexdef FROM pg_indexes
        WHERE indexname LIKE 'IDX_ACTIVITY_DESCRIPTION_TRGM_%'`,
    );
    expect(idx.map((i) => i.schemaname).sort()).toEqual(
      [...ACTIVITY_LOG_DESCRIPTION_SCHEMAS].sort(),
    );
    for (const i of idx) expect(i.indexdef).toContain('gin_trgm_ops');
  });

  it('TC7 "bekor" qidiruvi bekor qilish qatorini topadi (ActivityLogService)', async () => {
    const service = new ActivityLogService(
      ds.getRepository(ActivityLog),
      'order-service',
    );
    await service.log({
      entity_type: 'Order',
      entity_id: '990001',
      action: 'order.cancel',
      trace_id: marker,
      description: ActivityDescribeUz.orderCancelled('990001'),
    });
    // TC2 regressiya: description'siz yozuv ham o'tadi.
    await service.log({
      entity_type: 'Order',
      entity_id: '990002',
      action: 'created',
      trace_id: marker,
    });
    const page = await service.query({ search: 'bekor', trace_id: marker });
    expect(page.items.map((r) => r.entity_id)).toEqual(['990001']);
    expect(page.items[0].description).toBe('Buyurtma #990001 bekor qilindi');
  });

  it('TC10 down() ustunni muammosiz o`chiradi, up() qayta tiklaydi', async () => {
    await withRunner((qr) =>
      new AddActivityLogDescription1716000000062().down(qr),
    );
    expect(await columnInfo()).toEqual([]);
    await withRunner((qr) =>
      new AddActivityLogDescription1716000000062().up(qr),
    );
    expect((await columnInfo()).length).toBe(
      ACTIVITY_LOG_DESCRIPTION_SCHEMAS.length,
    );
  }, 60_000);

  it('TC11 100k qatorda description qidiruvi 1 soniyadan tez', async () => {
    await ds.query(`CREATE SCHEMA "${benchSchema}"`);
    await ds.query(
      // EXCLUDING DEFAULTS — order_schema ketma-ketligiga (id) tegilmasin.
      `CREATE TABLE "${benchSchema}".activity_logs
         (LIKE order_schema.activity_logs INCLUDING ALL EXCLUDING DEFAULTS)`,
    );
    await ds.query(
      `INSERT INTO "${benchSchema}".activity_logs
         (id, entity_type, entity_id, action, description, created_at)
       SELECT g, 'Order', g::text,
              CASE WHEN g % 50 = 0 THEN 'order.cancel' ELSE 'status_change' END,
              CASE WHEN g % 50 = 0
                   THEN 'Buyurtma #' || g || ' bekor qilindi'
                   ELSE 'Buyurtma #' || g || ' holati: Yangi → Qabul qilindi' END,
              now() - (g || ' seconds')::interval
         FROM generate_series(1, 100000) AS g`,
    );
    await ds.query(`ANALYZE "${benchSchema}".activity_logs`);

    // Indeks haqiqatan ishlatiladi (faqat description bo'yicha so'rovda).
    const plan = await ds.query<Array<Record<string, string>>>(
      `EXPLAIN SELECT id FROM "${benchSchema}".activity_logs
        WHERE description ILIKE '%bekor%'`,
    );
    expect(JSON.stringify(plan)).toMatch(/Bitmap Index Scan/);

    const bench = new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema: benchSchema,
      entities: [ActivityLog],
      synchronize: false,
    });
    await bench.initialize();
    try {
      const service = new ActivityLogService(bench.getRepository(ActivityLog));
      const started = Date.now();
      const page = await service.query({ search: 'bekor', limit: 50 });
      const elapsed = Date.now() - started;
      expect(page.meta.total).toBe(2000);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await bench.destroy();
    }
  }, 120_000);
});
