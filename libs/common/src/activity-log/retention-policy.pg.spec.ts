import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { requestContext } from '../context/request-context';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogArchive } from './activity-log-archive.entity';
import { ActivityLogMaintenanceService } from './activity-log-maintenance.service';
import { ActivityLogService } from './activity-log.service';
import { quoteActivityLogTable } from './retention';
import { resolveActivityLogRetentionPolicy } from './retention-policy';

/**
 * HAQIQIY POSTGRES testi (i6Nyedea) — FAQAT `ACTIVITY_PG_TEST_URI` bilan:
 *
 *   ACTIVITY_PG_TEST_URI=postgres://postgres@localhost:55463/spec \
 *     npx jest libs/common/src/activity-log/retention-policy.pg.spec.ts --runInBand
 *
 * Alohida vaqtinchalik sxema, oxirida DROP SCHEMA.
 */
const PG_URI = process.env.ACTIVITY_PG_TEST_URI;
const describePg = PG_URI ? describe : describe.skip;

describePg('activity_logs saqlash siyosati — real Postgres (i6Nyedea)', () => {
  let ds: DataSource;
  let maintenance: ActivityLogMaintenanceService;
  const schema = `spec_pol_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const table = quoteActivityLogTable(schema);

  const seed = async (action: string, ageDays: number, n = 1, tag = 'x') => {
    await ds.query(
      `INSERT INTO ${table} (entity_type, entity_id, action, created_at)
       SELECT 'Spec', $1 || '-' || g, $2, now() - make_interval(days => $3)
         FROM generate_series(1, $4) AS g`,
      [tag, action, ageDays, n],
    );
  };
  const countBy = async (where = 'TRUE') =>
    Number(
      (
        await ds.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${where}`)
      )[0].c,
    );

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: PG_URI,
      schema,
      // i6Nyedea arxiv (sukut yoqiq): o'chirish = arxivga ko'chirish, shuning
      // uchun AYNI sxemada arxiv jadvali ham kerak (archive.pg.spec.ts).
      entities: [ActivityLog, ActivityLogArchive],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query(`CREATE SCHEMA "${schema}"`);
    await ds.synchronize();
    const repo = ds.getRepository(ActivityLog);
    maintenance = new ActivityLogMaintenanceService(
      repo,
      new ActivityLogService(repo, 'identity-service'),
      'identity-service',
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query(`TRUNCATE ${table} RESTART IDENTITY`);
    await ds.query(
      `TRUNCATE ${quoteActivityLogTable(schema, 'activity_logs_archive')}`,
    );
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

  it('⭐ DRY-RUN — hech narsa o`chirilmaydi, faqat sanaladi', async () => {
    await mixed();
    const before = await countBy();

    const report = await maintenance.pruneByPolicy({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.rules).toEqual([
      { name: 'auth', days: 90, count: 6, batches: 0 },
      { name: 'default', days: 1095, count: 2, batches: 0 },
    ]);
    expect(await countBy()).toBe(before);
  });

  it('⭐ login/logout/auth_failure qisqa muddatdan keyin o`chadi, moliyaviy/investor qatorlari o`chmaydi', async () => {
    await mixed();

    const report = await maintenance.pruneByPolicy({
      dryRun: false,
      pauseMs: 0,
    });

    expect(report.rules.map((r) => [r.name, r.count])).toEqual([
      ['auth', 6],
      ['default', 2], // faqat 1200 kunlik order.sell (> 3 yil)
    ]);
    expect(await countBy(`action IN ('login','logout','auth_failure')`)).toBe(
      2,
    ); // yangilari
    expect(await countBy(`action = 'finance.manual_expense'`)).toBe(4);
    expect(await countBy(`action = 'investor.profit_calculated'`)).toBe(1);
    expect(await countBy(`action = 'order.sell'`)).toBe(0);
    // Prune natijasi activity_logs ga yozilmadi (o'zini to'ldirmaydi).
    expect(await countBy(`entity_type <> 'Spec'`)).toBe(0);
  });

  it('⭐ 100k qator — PARTIYALAB (bitta tranzaksiyada emas), parallel o`qish kutib qolmaydi', async () => {
    await seed('login', 200, 100_000, 'bulk');
    await seed('finance.manual_income', 200, 10, 'keep');
    const policy = resolveActivityLogRetentionPolicy({});
    const querySpy = jest.spyOn(ds.getRepository(ActivityLog), 'query');

    // Parallel "o'qish" (gateway /activity-logs kabi): har partiya orasida.
    const readLatencies: number[] = [];
    const sleep = async () => {
      const t = Date.now();
      await ds.query(
        `SELECT id FROM ${table} ORDER BY created_at DESC, id DESC LIMIT 20`,
      );
      readLatencies.push(Date.now() - t);
    };

    const started = Date.now();
    const report = await maintenance.pruneByPolicy({
      dryRun: false,
      policy,
      batchSize: 10_000,
      sleep,
      pauseMs: 1,
    });

    const auth = report.rules.find((r) => r.name === 'auth')!;
    expect(auth.count).toBe(100_000);
    expect(auth.batches).toBeGreaterThanOrEqual(10);
    const deleteCalls = querySpy.mock.calls.filter(([sql]) =>
      String(sql).includes('DELETE FROM'),
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(10);
    expect(await countBy()).toBe(10);
    // 12 s gateway timeout'idan ancha past.
    expect(Math.max(...readLatencies)).toBeLessThan(2000);
    expect(Date.now() - started).toBeLessThan(60_000);
    querySpy.mockRestore();
  }, 120_000);

  describe('takroriy login birlashtirish (logCoalesced)', () => {
    const ctx = (device: string) => ({
      traceId: 't-1',
      ip: '203.0.113.7',
      user_agent: 'UA',
      device_id: device,
    });
    const login = {
      entity_type: 'Auth',
      entity_id: '25',
      action: 'login',
      user_id: '25',
      user_name: 'TEST',
      user_role: 'courier',
    };

    it('⭐ AYNI qurilmadan N daqiqa ichida qayta login — yangi qator YO`Q, metadata.count oshadi', async () => {
      await requestContext.run(ctx('dev-1'), async () => {
        await maintenance.logCoalesced(login, 10 * 60_000);
        await maintenance.logCoalesced(login, 10 * 60_000);
        await maintenance.logCoalesced(login, 10 * 60_000);
      });
      const rows: Array<{ metadata: Record<string, unknown> }> = await ds.query(
        `SELECT metadata FROM ${table} WHERE action = 'login'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({
        count: 3,
        ip: '203.0.113.7',
        device_id: 'dev-1',
      });
      expect(rows[0].metadata.last_at).toEqual(expect.any(String));
    });

    it('boshqa qurilma yoki oyna tashqarisi — yangi qator', async () => {
      await requestContext.run(ctx('dev-1'), () =>
        maintenance.logCoalesced(login, 10 * 60_000),
      );
      await requestContext.run(ctx('dev-2'), () =>
        maintenance.logCoalesced(login, 10 * 60_000),
      );
      // Oynadan eski qator — birlashtirilmaydi.
      await ds.query(
        `UPDATE ${table} SET created_at = now() - interval '1 hour' WHERE metadata->>'device_id' = 'dev-1'`,
      );
      await requestContext.run(ctx('dev-1'), () =>
        maintenance.logCoalesced(login, 10 * 60_000),
      );
      expect(await countBy(`action = 'login'`)).toBe(3);
    });

    it('oyna 0 (ACTIVITY_LOG_LOGIN_DEDUP_MINUTES=0) — har login yangi qator', async () => {
      await requestContext.run(ctx('dev-1'), async () => {
        await maintenance.logCoalesced(login, 0);
        await maintenance.logCoalesced(login, 0);
      });
      expect(await countBy(`action = 'login'`)).toBe(2);
    });
  });
});
