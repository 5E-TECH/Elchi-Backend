import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DataSource, Logger as TypeOrmLogger, QueryRunner } from 'typeorm';
import { CreateActivityLogsTables1714800000000 } from '../../../../migrations/1714800000000-CreateActivityLogsTables';
import { CreateActivityLogsInIntegrationSchema1715000000000 } from '../../../../migrations/1715000000000-CreateActivityLogsInIntegrationSchema';
import { ExtendActivityLogsCoverage1716000000009 } from '../../../../migrations/1716000000009-ExtendActivityLogsCoverage';
import { AddActivityLogDescription1716000000062 } from '../../../../migrations/1716000000062-AddActivityLogDescription';
import { Cashbox_type, PaymentMethod } from '../../enums';
import { ActivityDescribeUz } from './describe-uz';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogService } from './activity-log.service';

/**
 * UNUMDORLIK O'LCHOVI — HAQIQIY POSTGRES (2WRzdWpZ TC11 + TC4).
 *
 *   "description ILIKE qidiruvi 100k qatorli jadvalda 1 soniyadan tez
 *    (trgm indeks bilan o'lchangan)"
 *
 * `activity-log.description.pg.spec.ts` TC11 bitta o'lchov qiladi; bu yerda —
 * bir necha qidiruv so'zi bo'yicha median/p95, servis YUBORADIGAN aniq SQL
 * (sahifa + COUNT) uchun `EXPLAIN (ANALYZE, BUFFERS)`, va trgm indeksining
 * o'zi ishlatilishi (faqat description bo'yicha so'rov).
 *
 * FAQAT `ACTIVITY_PG_TEST_URI` berilganda ishlaydi (CI va oddiy `jest` da skip):
 *
 *   ACTIVITY_PG_TEST_URI=postgres://user:pass@127.0.0.1:5432/test_db \
 *     npx jest libs/common/src/activity-log/activity-log.search.bench.pg.spec.ts --runInBand
 *
 * Ixtiyoriy: `ACTIVITY_BENCH_ROWS` (sukut 100000; 100 ga karrali bo'lsin —
 * kutilgan `total` shundan hisoblanadi), `PG_BENCH_OUT=<papka>`.
 *
 * ⚠️ FAQAT TEST BAZASIDA. O'lchov alohida vaqtinchalik sxemada (jadval
 * `order_schema.activity_logs` dan `LIKE ... INCLUDING ALL` — 062 dagi qisman
 * GIN `gin_trgm_ops` indeksi ham ko'chadi), oxirida DROP SCHEMA.
 */
const PG_URI = process.env.ACTIVITY_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

const ROWS = Number(process.env.ACTIVITY_BENCH_ROWS ?? 100_000);
const LIMIT_MS = 1_000;
const RUNS = 15;

interface Stats {
  runs: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    runs: sorted.length,
    min: round(sorted[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
  };
}

/** Servis yuborgan SQL'ni (parametrlari bilan) ushlab qoladi — EXPLAIN uchun. */
class CapturingLogger implements TypeOrmLogger {
  captured: Array<{ query: string; parameters?: unknown[] }> = [];
  logQuery(query: string, parameters?: unknown[]) {
    this.captured.push({ query, parameters });
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

describePg('activity_logs qidiruvi — PG unumdorlik (2WRzdWpZ)', () => {
  let ds: DataSource;
  let bench: DataSource;
  let service: ActivityLogService;
  const sqlLog = new CapturingLogger();
  const benchSchema = `bench_alog_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const table = () => `"${benchSchema}".activity_logs`;
  const results: Record<string, unknown> = {};
  const plans: Record<string, string> = {};

  const withRunner = async (fn: (qr: QueryRunner) => Promise<void>) => {
    const qr = ds.createQueryRunner();
    try {
      await fn(qr);
    } finally {
      await qr.release();
    }
  };

  const explain = async (
    name: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<string> => {
    const rows = await bench.query<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      params,
    );
    const text = rows.map((r) => r['QUERY PLAN']).join('\n');
    plans[name] = text;
    // eslint-disable-next-line no-console
    console.log(`[explain] ${name}\n${text}`);
    return text;
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
    const probe = await ds.query<Array<{ order: string | null }>>(
      `SELECT to_regclass('order_schema.activity_logs') AS "order"`,
    );
    await withRunner(async (qr) => {
      if (!probe[0]?.order) {
        await new CreateActivityLogsTables1714800000000().up(qr);
        await new CreateActivityLogsInIntegrationSchema1715000000000().up(qr);
        await new ExtendActivityLogsCoverage1716000000009().up(qr);
      }
      await new AddActivityLogDescription1716000000062().up(qr);
    });

    await ds.query(`CREATE SCHEMA "${benchSchema}"`);
    // EXCLUDING DEFAULTS — order_schema ketma-ketligiga tegilmasin; o'rniga
    // o'z IDENTITY'si (TC4 yozuvi `log()` orqali o'tadi).
    await ds.query(
      `CREATE TABLE ${table()}
         (LIKE order_schema.activity_logs INCLUDING ALL EXCLUDING DEFAULTS)`,
    );
    await ds.query(
      `ALTER TABLE ${table()}
         ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 10000000),
         ALTER COLUMN created_at SET DEFAULT now()`,
    );
    // Prod'ga o'xshash aralashma: 20% eski (description NULL), status
    // o'zgarishi, 2% bekor qilish, sotuv, kassa kirim/chiqim, login.
    await ds.query(
      `INSERT INTO ${table()}
         (id, entity_type, entity_id, action, user_id, user_name, user_role,
          service, description, created_at)
       SELECT g,
              CASE WHEN k BETWEEN 80 AND 89 THEN 'Cashbox'
                   WHEN k >= 90 THEN 'User' ELSE 'Order' END,
              (100000 + g)::text,
              CASE WHEN k < 70 THEN 'status_change'
                   WHEN k < 72 THEN 'order.cancel'
                   WHEN k < 80 THEN 'order.sold'
                   WHEN k < 85 THEN 'finance.manual_expense'
                   WHEN k < 90 THEN 'finance.manual_income'
                   ELSE 'login' END,
              (g % 300)::text,
              (ARRAY['Ali Valiyev','Dilshod Urozov','Shodiyor Ergashev',
                     'Aziza Karimova','Bekzod Tursunov'])[1 + g % 5],
              (ARRAY['registrator','manager','admin','courier'])[1 + g % 4],
              'order-service',
              CASE WHEN k < 20 THEN NULL
                   WHEN k < 70 THEN 'Buyurtma #' || (100000 + g) || ' holati: Yangi → Qabul qilindi'
                   WHEN k < 72 THEN 'Buyurtma #' || (100000 + g) || ' bekor qilindi'
                   WHEN k < 80 THEN 'Buyurtma #' || (100000 + g) || ' sotildi — 150 000 so''m'
                   WHEN k < 85 THEN 'Kassadan chiqim: 1 250 000 so''m (Asosiy kassa, naqd)'
                   WHEN k < 90 THEN 'Kassaga kirim: 50 000 so''m (Filial kassasi)'
                   ELSE (ARRAY['Ali Valiyev','Dilshod Urozov','Shodiyor Ergashev',
                               'Aziza Karimova','Bekzod Tursunov'])[1 + g % 5]
                        || ' tizimga kirdi' END,
              now() - (g || ' seconds')::interval
         FROM (SELECT g, g % 100 AS k FROM generate_series(1, $1::int) AS g) AS t`,
      [ROWS],
    );
    await ds.query(`VACUUM ANALYZE ${table()}`);

    bench = new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema: benchSchema,
      entities: [ActivityLog],
      synchronize: false,
      logging: ['query'],
      logger: sqlLog,
    });
    await bench.initialize();
    service = new ActivityLogService(bench.getRepository(ActivityLog));
  }, 300_000);

  afterAll(async () => {
    if (bench?.isInitialized) await bench.destroy();
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS "${benchSchema}" CASCADE`);
      await ds.destroy();
    }
    const out = process.env.PG_BENCH_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, 'activity-log-search.json'),
        JSON.stringify({ rows: ROWS, scenarios: results, plans }, null, 2),
      );
    }
  }, 120_000);

  it('jadval hajmi va trgm indeksi bench sxemasida mavjud', async () => {
    const size = await bench.query<
      Array<{ rows: string; table_size: string; trgm_size: string | null }>
    >(
      `SELECT (SELECT count(*) FROM ${table()})::text AS rows,
              pg_size_pretty(pg_total_relation_size('${table()}')) AS table_size,
              (SELECT pg_size_pretty(pg_relation_size(i.indexrelid))
                 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                WHERE i.indrelid = '${table()}'::regclass
                  AND pg_get_indexdef(i.indexrelid) LIKE '%gin_trgm_ops%') AS trgm_size`,
    );
    results.table = size[0];
    // eslint-disable-next-line no-console
    console.log(`[bench] table: ${JSON.stringify(size[0])}`);
    expect(Number(size[0].rows)).toBe(ROWS);
    expect(size[0].trgm_size).not.toBeNull();
  });

  it('description ILIKE (faqat description) — Bitmap Index Scan trgm indeks bilan', async () => {
    const plan = await explain(
      'description_only_bekor',
      `SELECT id FROM ${table()} WHERE description ILIKE $1`,
      ['%bekor%'],
    );
    expect(plan).toMatch(/Bitmap Index Scan on .*description/i);

    // Taqqoslash: indekssiz (planner'da indeks taqiqlanganda) shu so'rov.
    const qr = bench.createQueryRunner();
    try {
      await qr.startTransaction();
      await qr.query('SET LOCAL enable_bitmapscan = off');
      await qr.query('SET LOCAL enable_indexscan = off');
      const rows = await qr.query(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM ${table()} WHERE description ILIKE $1`,
        ['%bekor%'],
      );
      const text = (rows as Array<{ 'QUERY PLAN': string }>)
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      plans.description_only_bekor_no_index = text;
      // eslint-disable-next-line no-console
      console.log(`[explain] description_only_bekor_no_index\n${text}`);
      expect(text).toMatch(/Seq Scan/);
      await qr.rollbackTransaction();
    } finally {
      await qr.release();
    }
  }, 120_000);

  const terms: Array<[string, string, number | null]> = [
    // [nom, qidiruv so'zi, kutilgan total (null — tekshirilmaydi)]
    ['bekor', 'bekor', ROWS / 50],
    ['chiqim', 'chiqim', ROWS / 20],
    ['ism_ali', 'Ali', null],
    ['topilmaydi', 'zzqx-yoq', 0],
    ['keng_buyurtma', 'Buyurtma', null],
  ];

  it.each(terms)(
    'ActivityLogService.query({search: %s}) — median/p95 < 1 s',
    async (name, term, expectedTotal) => {
      // Isitish (reja keshlari, buferlar).
      await service.query({ search: term, limit: 50 });
      await service.query({ search: term, limit: 50 });
      const samples: number[] = [];
      let total = -1;
      for (let i = 0; i < RUNS; i += 1) {
        const started = performance.now();
        const page = await service.query({ search: term, limit: 50 });
        samples.push(performance.now() - started);
        total = page.meta.total;
      }
      const result = {
        ...stats(samples),
        total,
        samples_ms: samples.map((v) => Math.round(v)),
      };
      results[`search_${name}`] = result;
      // eslint-disable-next-line no-console
      console.log(`[bench] search_${name}: ${JSON.stringify(result)}`);
      if (expectedTotal !== null) expect(total).toBe(expectedTotal);
      expect(result.p95).toBeLessThan(LIMIT_MS);
    },
    120_000,
  );

  it('servis yuborgan ANIQ SQL (sahifa + COUNT) uchun EXPLAIN ANALYZE', async () => {
    sqlLog.captured = [];
    await service.query({ search: 'bekor', limit: 50 });
    const statements = sqlLog.captured.filter((c) =>
      /^\s*SELECT/i.test(c.query),
    );
    expect(statements.length).toBe(2);
    const count = statements.find((c) => /COUNT\(/i.test(c.query));
    const pageSql = statements.find((c) => !/COUNT\(/i.test(c.query));
    expect(count && pageSql).toBeTruthy();
    results.service_sql = {
      page: pageSql!.query,
      count: count!.query,
      parameters: pageSql!.parameters,
    };
    const pagePlan = await explain(
      'service_page_bekor',
      pageSql!.query,
      pageSql!.parameters ?? [],
    );
    const countPlan = await explain(
      'service_count_bekor',
      count!.query,
      count!.parameters ?? [],
    );
    const execMs = (plan: string) =>
      Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);
    results.service_sql_execution_ms = {
      page: execMs(pagePlan),
      count: execMs(countPlan),
    };
    expect(execMs(pagePlan)).toBeLessThan(LIMIT_MS);
    expect(execMs(countPlan)).toBeLessThan(LIMIT_MS);
  }, 120_000);

  it('TC4 kassa chiqimi: summa ming ajratgichi bilan PG da ham saqlanadi va qidiriladi', async () => {
    const marker = `bench-tc4-${randomUUID()}`.slice(0, 64);
    await service.log({
      entity_type: 'Cashbox',
      entity_id: 'cb-bench',
      action: 'finance.manual_expense',
      trace_id: marker,
      description: ActivityDescribeUz.cashboxExpense(
        125_000_000,
        Cashbox_type.MAIN,
        PaymentMethod.CASH,
      ),
    });
    const page = await service.query({
      search: '125 000 000',
      trace_id: marker,
    });
    expect(page.items.map((r) => r.description)).toEqual([
      "Kassadan chiqim: 125 000 000 so'm (Asosiy kassa, naqd)",
    ]);
  });
});
