import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateActivityLogsTables1714800000000 } from '../../../../migrations/1714800000000-CreateActivityLogsTables';
import { CreateActivityLogsInIntegrationSchema1715000000000 } from '../../../../migrations/1715000000000-CreateActivityLogsInIntegrationSchema';
import { ExtendActivityLogsCoverage1716000000009 } from '../../../../migrations/1716000000009-ExtendActivityLogsCoverage';
import { CreateAiSchema1716000000047 } from '../../../../migrations/1716000000047-CreateAiSchema';
import { AddActivityLogDescription1716000000062 } from '../../../../migrations/1716000000062-AddActivityLogDescription';
import {
  ACTIVITY_LOG_ARCHIVE_SCHEMAS,
  CreateActivityLogsArchive1716000000101,
} from '../../../../migrations/1716000000101-CreateActivityLogsArchive';
import { ActivityLogArchive } from './activity-log-archive.entity';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogMaintenanceService } from './activity-log-maintenance.service';
import { ActivityLogService } from './activity-log.service';
import { quoteActivityLogTable } from './retention';
import { resolveActivityLogRetentionPolicy } from './retention-policy';

/**
 * HAQIQIY POSTGRES testi (i6Nyedea TC "Arxiv varianti tanlangan bo'lsa,
 * o'chirilgan qatorlar arxivda topiladi") — FAQAT `ACTIVITY_PG_TEST_URI` bilan:
 *
 *   ACTIVITY_PG_TEST_URI=postgres://postgres@127.0.0.1:55484/elchi_r4_test \
 *     npx jest libs/common/src/activity-log/archive.pg.spec.ts --runInBand
 *
 * ⚠️ FAQAT TEST BAZASIDA. Migratsiya bloki audit sxemalarida (order_schema
 * ...) hot jadval bo'lmasa oldingi migratsiyalarni `up()` qiladi, 101 ni
 * up → down → up aylantiradi. Ko'chirish testlari alohida vaqtinchalik
 * sxemada (oxirida DROP SCHEMA).
 */
const PG_URI = process.env.ACTIVITY_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

describePg('activity_logs arxivi — real Postgres (i6Nyedea)', () => {
  let ds: DataSource;
  const schema = `spec_arch_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const bare = `${schema}_bare`;
  const table = quoteActivityLogTable(schema);
  const archive = quoteActivityLogTable(schema, 'activity_logs_archive');
  let maintenance: ActivityLogMaintenanceService;
  let service: ActivityLogService;

  const withRunner = async (fn: (qr: QueryRunner) => Promise<void>) => {
    const qr = ds.createQueryRunner();
    try {
      await fn(qr);
    } finally {
      await qr.release();
    }
  };

  const seed = async (
    action: string,
    ageDays: number,
    n = 1,
    tag = 'x',
  ): Promise<void> => {
    await ds.query(
      `INSERT INTO ${table}
         (entity_type, entity_id, action, old_value, new_value, user_id,
          user_name, user_role, service, trace_id, metadata, description, created_at)
       SELECT 'Spec', $1 || '-' || g, $2, '{"a":1}'::jsonb, '{"b":2}'::jsonb,
              '25', 'TEST', 'superadmin', 'order-service', 'tr-' || g,
              jsonb_build_object('ip', '203.0.113.7', 'user_agent', 'UA',
                                 'device_id', 'dev', 'device_name', 'Tel',
                                 'reason', 'saqlansin'),
              'Spec #' || g, now() - make_interval(days => $3)
         FROM generate_series(1, $4) AS g`,
      [tag, action, ageDays, n],
    );
  };
  const count = async (t: string, where = 'TRUE') =>
    Number(
      (await ds.query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE ${where}`))[0]
        .c,
    );

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema,
      entities: [ActivityLog, ActivityLogArchive],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query(`CREATE SCHEMA "${schema}"`);
    await ds.synchronize();
    const repo = ds.getRepository(ActivityLog);
    service = new ActivityLogService(repo, 'order-service');
    maintenance = new ActivityLogMaintenanceService(
      repo,
      service,
      'order-service',
    );
  }, 60_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ds.query(`DROP SCHEMA IF EXISTS "${bare}" CASCADE`);
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query(`TRUNCATE ${table} RESTART IDENTITY`);
    await ds.query(`TRUNCATE ${archive}`);
  });

  const mixed = async () => {
    await seed('login', 120, 3, 'old-login');
    await seed('logout', 120, 2, 'old-logout');
    await seed('auth_failure', 120, 1, 'old-fail');
    await seed('login', 10, 2, 'fresh-login');
    await seed('finance.manual_expense', 400, 4, 'old-fin');
    await seed('investor.profit_calculated', 800, 1, 'old-inv');
    await seed('order.sell', 1200, 2, 'ancient-order');
  };

  it('⭐ o`chirilgan HAR qator arxivda topiladi — ustunlar AYNAN, IP/qurilma kalitlarisiz', async () => {
    await mixed();
    const willGo: Array<Record<string, any>> = await ds.query(
      `SELECT * FROM ${table}
        WHERE (action IN ('login','logout','auth_failure') AND created_at < now() - interval '90 days')
           OR (action = 'order.sell')
        ORDER BY id`,
    );
    expect(willGo).toHaveLength(8);

    const report = await maintenance.pruneByPolicy({
      dryRun: false,
      pauseMs: 0,
    });

    expect(report.archive).toMatchObject({ enabled: true, ready: true });
    expect(report.rules.map((r) => [r.name, r.count, r.archived])).toEqual([
      ['auth', 6, 6],
      ['default', 2, 2],
    ]);
    // Hot jadvaldan ketdi, moliyaviy/investor va yangi loginlar QOLDI.
    expect(await count(table)).toBe(7);
    expect(await count(table, `action = 'finance.manual_expense'`)).toBe(4);
    expect(await count(table, `action = 'investor.profit_calculated'`)).toBe(1);

    const got: Array<Record<string, any>> = await ds.query(
      `SELECT * FROM ${archive} ORDER BY id`,
    );
    expect(got.map((r) => String(r.id))).toEqual(
      willGo.map((r) => String(r.id)),
    );
    for (const [i, row] of got.entries()) {
      const src = willGo[i];
      for (const col of [
        'entity_type',
        'entity_id',
        'action',
        'old_value',
        'new_value',
        'user_id',
        'user_name',
        'user_role',
        'service',
        'trace_id',
        'description',
      ]) {
        expect({ col, v: row[col] }).toEqual({ col, v: src[col] });
      }
      expect(new Date(row.created_at).getTime()).toBe(
        new Date(src.created_at).getTime(),
      );
      // f2Ud5tju: arxivga IP/qurilma tushmaydi, boshqa kalitlar saqlanadi.
      expect(row.metadata).toEqual({ reason: 'saqlansin' });
      expect(row.archive_rule).toBe(
        src.action === 'order.sell' ? 'default' : 'auth',
      );
      expect(row.archived_at).toBeInstanceOf(Date);
    }
  });

  it('⭐ arxiv o`qiladi: ActivityLogService.query({ archive: true }) — filtrlar va kursor yo`li', async () => {
    await mixed();
    await maintenance.pruneByPolicy({ dryRun: false, pauseMs: 0 });

    const page = await service.query({ archive: true, action: 'order.sell' });
    expect(page.meta.total).toBe(2);
    expect(page.items.map((r) => r.entity_id).sort()).toEqual([
      'ancient-order-1',
      'ancient-order-2',
    ]);
    expect(page.items[0]).toMatchObject({ archive_rule: 'default' });
    // Hot jadvalda endi yo'q.
    expect((await service.query({ action: 'order.sell' })).meta.total).toBe(0);

    // Gateway kursor yo'li (with_total + keyset) arxivda ham ishlaydi.
    const cursor = await service.query({
      archive: true,
      entity_id: 'old-login-2',
      with_total: true,
      limit: 5,
    });
    expect(cursor.meta.total).toBe(1);
    expect(cursor.items[0]).toMatchObject({
      action: 'login',
      cursor_ts: expect.any(String),
    });
  });

  it('⭐ ATOMAR: INSERT yiqilsa (dublikat id) DELETE ham bekor — qator yo`qolmaydi', async () => {
    await seed('login', 200, 5, 'dup');
    const [first] = await ds.query(
      `SELECT id FROM ${table} ORDER BY id LIMIT 1`,
    );
    // Arxivda AYNI id allaqachon bor (masalan qo'lda tiklangan qator).
    await ds.query(
      `INSERT INTO ${archive} (id, entity_type, entity_id, action, created_at)
       VALUES ($1, 'Spec', 'pre', 'login', now())`,
      [first.id],
    );

    await expect(
      maintenance.pruneByPolicy({ dryRun: false, pauseMs: 0 }),
    ).rejects.toThrow(/duplicate key|unique/i);

    expect(await count(table)).toBe(5);
    expect(await count(archive)).toBe(1);
  });

  it('⭐ arxiv jadvali yo`q sxemada o`chirish RAD etiladi — hech narsa o`chmaydi', async () => {
    const bareDs = new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema: bare,
      entities: [ActivityLog],
      synchronize: false,
    });
    await bareDs.initialize();
    try {
      await bareDs.query(`CREATE SCHEMA IF NOT EXISTS "${bare}"`);
      await bareDs.synchronize();
      const t = quoteActivityLogTable(bare);
      await bareDs.query(
        `INSERT INTO ${t} (entity_type, entity_id, action, created_at)
         SELECT 'Spec', g::text, 'login', now() - interval '200 days'
           FROM generate_series(1, 3) AS g`,
      );
      const repo = bareDs.getRepository(ActivityLog);
      const m = new ActivityLogMaintenanceService(
        repo,
        new ActivityLogService(repo),
        'order-service',
      );
      const dry = await m.pruneByPolicy({ dryRun: true });
      expect(dry.archive).toMatchObject({ enabled: true, ready: false });
      await expect(
        m.pruneByPolicy({ dryRun: false, pauseMs: 0 }),
      ).rejects.toThrow(/activity_logs_archive/);
      expect(
        Number(
          (await bareDs.query(`SELECT COUNT(*)::int AS c FROM ${t}`))[0].c,
        ),
      ).toBe(3);
    } finally {
      await bareDs.destroy();
    }
  });

  it('⭐ 30k qator — PARTIYALAB ko`chiriladi (har partiya alohida buyruq), parallel o`qish kutib qolmaydi', async () => {
    await seed('login', 200, 30_000, 'bulk');
    await seed('finance.manual_income', 200, 10, 'keep');
    const querySpy = jest.spyOn(ds.getRepository(ActivityLog), 'query');
    const readLatencies: number[] = [];
    const sleep = async () => {
      const t = Date.now();
      await ds.query(
        `SELECT id FROM ${table} ORDER BY created_at DESC, id DESC LIMIT 20`,
      );
      readLatencies.push(Date.now() - t);
    };

    const report = await maintenance.pruneByPolicy({
      dryRun: false,
      policy: resolveActivityLogRetentionPolicy({}),
      batchSize: 10_000,
      pauseMs: 1,
      sleep,
    });

    const auth = report.rules.find((r) => r.name === 'auth')!;
    expect(auth).toMatchObject({ count: 30_000, archived: 30_000 });
    expect(auth.batches).toBeGreaterThanOrEqual(3);
    const moves = querySpy.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO'),
    );
    expect(moves.length).toBeGreaterThanOrEqual(3);
    expect(await count(table)).toBe(10);
    expect(await count(archive)).toBe(30_000);
    expect(Math.max(...readLatencies)).toBeLessThan(2000);
    querySpy.mockRestore();
  }, 120_000);

  describe('migratsiya 1716000000101 (audit sxemalarida)', () => {
    beforeAll(async () => {
      await ds.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      const [probe] = await ds.query<
        Array<{ order: string | null; ai: string | null }>
      >(
        `SELECT to_regclass('order_schema.activity_logs') AS "order",
                to_regclass('ai_schema.activity_logs') AS ai`,
      );
      await withRunner(async (qr) => {
        if (!probe?.order) {
          await new CreateActivityLogsTables1714800000000().up(qr);
          await new CreateActivityLogsInIntegrationSchema1715000000000().up(qr);
          await new ExtendActivityLogsCoverage1716000000009().up(qr);
        }
        if (!probe?.ai) await new CreateAiSchema1716000000047().up(qr);
        await new AddActivityLogDescription1716000000062().up(qr);
        await new CreateActivityLogsArchive1716000000101().up(qr);
        // Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
        await new CreateActivityLogsArchive1716000000101().up(qr);
      });
    }, 120_000);

    const cols = (tableName: string) =>
      ds.query<
        Array<{
          table_schema: string;
          column_name: string;
          data_type: string;
          len: number | null;
          is_nullable: string;
        }>
      >(
        `SELECT table_schema, column_name, data_type,
                character_maximum_length AS len, is_nullable
           FROM information_schema.columns
          WHERE table_name = $1 AND table_schema = ANY($2::text[])
          ORDER BY table_schema, column_name`,
        [tableName, ACTIVITY_LOG_ARCHIVE_SCHEMAS],
      );

    it('⭐ HAR audit sxemasida arxiv jadvali; ustunlar hot jadval bilan tur/uzunlik/NULL bo`yicha AYNAN', async () => {
      const hot = await cols('activity_logs');
      const arch = await cols('activity_logs_archive');
      const schemas = [...new Set(arch.map((c) => c.table_schema))].sort();
      expect(schemas).toEqual([...ACTIVITY_LOG_ARCHIVE_SCHEMAS].sort());
      const key = (c: { table_schema: string; column_name: string }) =>
        `${c.table_schema}.${c.column_name}`;
      const archByKey = new Map(arch.map((c) => [key(c), c]));
      for (const h of hot) {
        expect({ col: key(h), ...archByKey.get(key(h)) }).toEqual({
          col: key(h),
          ...h,
        });
      }
      const extra = arch
        .filter((c) => !hot.some((h) => key(h) === key(c)))
        .map((c) => c.column_name);
      expect([...new Set(extra)].sort()).toEqual([
        'archive_rule',
        'archived_at',
      ]);
    });

    it('⭐ down(): arxivda qator bo`lsa RAD; bo`sh bo`lsa tushiriladi; up() qayta tiklaydi', async () => {
      await ds.query(
        `INSERT INTO finance_schema.activity_logs_archive
           (id, entity_type, entity_id, action, created_at)
         VALUES (999999999, 'Spec', 'down', 'finance.x', now())`,
      );
      try {
        await expect(
          withRunner((qr) =>
            new CreateActivityLogsArchive1716000000101().down(qr),
          ),
        ).rejects.toThrow(/finance_schema/);
        expect((await cols('activity_logs_archive')).length).toBeGreaterThan(0);
      } finally {
        await ds.query(
          `DELETE FROM finance_schema.activity_logs_archive WHERE id = 999999999`,
        );
      }
      await withRunner((qr) =>
        new CreateActivityLogsArchive1716000000101().down(qr),
      );
      expect(await cols('activity_logs_archive')).toEqual([]);
      await withRunner((qr) =>
        new CreateActivityLogsArchive1716000000101().up(qr),
      );
      const restored = new Set(
        (await cols('activity_logs_archive')).map((c) => c.table_schema),
      );
      expect(restored.size).toBe(ACTIVITY_LOG_ARCHIVE_SCHEMAS.length);
    }, 60_000);
  });
});
