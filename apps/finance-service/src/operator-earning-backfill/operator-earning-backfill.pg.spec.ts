import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { parseEarningBackfillArgs } from './operator-earning-backfill';
import { runOperatorEarningBackfill } from './operator-earning-backfill.runner';

/**
 * 2026-11-22 — `scripts/backfill-operator-earnings.ts`: o'tgan sotuvlarga
 * JORIY stavka bilan operator komissiyasi, BARCHA operatorlar uchun, HAQIQIY
 * Postgres'da (o'z vaqtinchalik sxemalari — order / identity / finance):
 *  - DRY-RUN hech narsa yozmaydi, hisobot sanoqlari to'g'ri;
 *  - faqat qatori UMUMAN yo'q, sotilgan, o'chirilmagan, stavkali market
 *    operatori buyurtmalari; tirik va rollback qilingan qator tegilmaydi;
 *  - summa aniq `numeric` hisobida, stavka surati qatorda;
 *  - qayta yurgizish — 0 ta yangi qator, 0 ta yangi audit;
 *  - jonli yozuv bilan poyga — ikkinchi qator yo'q;
 *  - ikkinchi nusxa (advisory lock) — yozmaydi.
 * Env (`FINANCE_PG_TEST_URI`) bo'lmasa skip.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('operator earnings backfill skripti (haqiqiy Postgres)', () => {
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const schemas = {
    order: `spec_obf_${tag}_o`,
    identity: `spec_obf_${tag}_i`,
    finance: `spec_obf_${tag}_f`,
  };
  const O = `"${schemas.order}"`;
  const I = `"${schemas.identity}"`;
  const F = `"${schemas.finance}"`;
  let db: DataSource;
  let runner: QueryRunner;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  const apply = (batch = 2) =>
    parseEarningBackfillArgs(['--apply', `--batch=${batch}`]);
  const dryRun = () => parseEarningBackfillArgs([]);
  const run = (args = dryRun(), q: QueryRunner = runner) =>
    runOperatorEarningBackfill(q, args, log, schemas);

  const earnings = () =>
    db.query<Array<Record<string, string | boolean | null>>>(
      `SELECT order_id::text, operator_id::text, market_id::text,
              amount::text, commission_type, commission_value::text,
              order_total_price::text, is_deleted
       FROM ${F}.operator_earnings ORDER BY order_id, id`,
    );
  const logs = () =>
    db.query<AuditRow[]>(
      `SELECT entity_type, entity_id, action, new_value, metadata, user_role,
              service, description
       FROM ${F}.activity_logs ORDER BY id`,
    );
  type AuditRow = {
    entity_type: string;
    entity_id: string;
    action: string;
    new_value: { created: number; amount: number };
    metadata: {
      reason: string;
      source: string;
      run_id: string;
      order_ids: string[];
      earning_ids: string[];
      commission_type: string;
      commission_value: number;
    };
    user_role: string;
    service: string;
    description: string;
  };

  beforeAll(async () => {
    db = new DataSource({ type: 'postgres', url: pgUri, extra: { max: 4 } });
    await db.initialize();
    for (const s of Object.values(schemas)) {
      await db.query(`CREATE SCHEMA "${s}"`);
    }
    await db.query(`
      CREATE TYPE ${O}.orders_status_enum AS ENUM
        ('new', 'waiting', 'sold', 'paid', 'partly_paid', 'cancelled');
      CREATE TABLE ${O}.orders (
        id BIGSERIAL PRIMARY KEY,
        is_deleted BOOLEAN NOT NULL DEFAULT false,
        market_id BIGINT NOT NULL,
        operator_id BIGINT,
        operator VARCHAR,
        total_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
        status ${O}.orders_status_enum NOT NULL DEFAULT 'new'
      );
      CREATE TYPE ${I}.admins_role_enum AS ENUM
        ('superadmin', 'market', 'market_operator', 'courier');
      CREATE TYPE ${I}.admins_commission_type_enum AS ENUM ('percent', 'fixed');
      CREATE TABLE ${I}.admins (
        id BIGSERIAL PRIMARY KEY,
        is_deleted BOOLEAN NOT NULL DEFAULT false,
        name VARCHAR NOT NULL,
        role ${I}.admins_role_enum NOT NULL,
        commission_type ${I}.admins_commission_type_enum,
        commission_value NUMERIC(14, 2)
      );
      -- Migratsiya 1715100000000 + 1715900000000 (numeric) bilan bir xil.
      CREATE TABLE ${F}.operator_earnings (
        id BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_deleted BOOLEAN NOT NULL DEFAULT false,
        operator_id BIGINT NOT NULL,
        order_id BIGINT NOT NULL,
        market_id BIGINT,
        amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        commission_type VARCHAR(16),
        commission_value NUMERIC(14, 2),
        order_total_price NUMERIC(14, 2)
      );
      CREATE UNIQUE INDEX "UQ_OPERATOR_EARNING_ORDER"
        ON ${F}.operator_earnings (order_id) WHERE is_deleted = false;
      CREATE TABLE ${F}.activity_logs (
        id BIGSERIAL PRIMARY KEY,
        entity_type VARCHAR(64) NOT NULL,
        entity_id VARCHAR(100) NOT NULL,
        action VARCHAR(64) NOT NULL,
        old_value JSONB,
        new_value JSONB,
        user_id VARCHAR(100),
        user_name VARCHAR(200),
        user_role VARCHAR(32),
        service VARCHAR(32),
        trace_id VARCHAR(64),
        metadata JSONB,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`
      INSERT INTO ${I}.admins (id, name, role, commission_type, commission_value, is_deleted) VALUES
        (1, 'Market A', 'market', NULL, NULL, false),
        (2, 'Market B', 'market', NULL, NULL, false),
        (10, 'Shahzoda', 'market_operator', 'percent', 5, false),
        (11, 'Dilnoza', 'market_operator', 'fixed', 3000, false),
        (12, 'Stavkasiz', 'market_operator', NULL, NULL, false),
        (13, 'Ketgan', 'market_operator', 'percent', 10, true),
        (14, 'Kuryer', 'courier', 'percent', 5, false);
      INSERT INTO ${O}.orders (id, market_id, operator_id, operator, total_price, status, is_deleted) VALUES
        (101, 1, 10, NULL, 100000, 'sold', false),
        (102, 1, 10, NULL, 12345.50, 'paid', false),
        (103, 2, 11, NULL, 50000, 'partly_paid', false),
        (104, 1, 10, NULL, 0, 'sold', false),
        (105, 1, 10, NULL, 70000, 'new', false),
        (106, 1, 10, NULL, 70000, 'sold', true),
        (107, 1, 10, NULL, 70000, 'sold', false),
        (108, 1, 10, NULL, 70000, 'sold', false),
        (109, 1, 12, NULL, 70000, 'sold', false),
        (110, 1, 13, NULL, 20000, 'sold', false),
        (111, 1, 14, NULL, 70000, 'sold', false),
        (112, 1, NULL, 'Ali', 70000, 'sold', false),
        (113, 2, 11, NULL, 70000, 'cancelled', false);
      -- 107: jonli qator (eski stavka 999) — tegilmasin;
      -- 108: rollback qilingan (o'chirilgan) qator — tegilmasin, yangisi ham yo'q.
      INSERT INTO ${F}.operator_earnings
        (operator_id, order_id, market_id, amount, commission_type, commission_value, order_total_price, is_deleted)
      VALUES
        (10, 107, 1, 999, 'fixed', 999, 70000, false),
        (10, 108, 1, 3500, 'percent', 5, 70000, true);
    `);
    runner = db.createQueryRunner();
    await runner.connect();
  }, 30_000);

  afterAll(async () => {
    if (runner) await runner.release();
    if (db?.isInitialized) {
      for (const s of Object.values(schemas)) {
        await db.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      await db.destroy();
    }
  });

  it("DRY-RUN: hech narsa yozilmaydi, sanoqlar to'g'ri", async () => {
    const before = await earnings();
    const report = await run();

    expect(report.apply).toBe(false);
    expect(report.stats).toEqual({
      sold_with_operator: 9, // 101,102,103,104,107,108,109,110,111
      already_recorded: 1, // 107
      deleted_row_only: 1, // 108
      operator_without_rate: 1, // 109
      operator_other_role: 1, // 111 (kuryer)
      unlinked_text_only: 1, // 112
    });
    expect(report.zero_amount).toBe(1); // 104 (narx 0)
    expect(report.planned).toBe(4); // 101, 102, 103, 110
    // 5000 + round(617.275)=617.28 + 3000 + 2000
    expect(report.planned_cents).toBe(500000 + 61728 + 300000 + 200000);
    expect(report.created).toBe(0);
    // Hisobot: o'chirilgan operator belgilangan, eng katta summa birinchi.
    expect(report.groups.map((g) => [g.operator_id, g.planned])).toEqual([
      ['10', 2],
      ['11', 1],
      ['13', 1],
    ]);
    expect(report.groups.find((g) => g.operator_id === '13')).toMatchObject({
      operator_deleted: true,
      market_name: 'Market A',
    });

    expect(await earnings()).toEqual(before);
    expect(await logs()).toEqual([]);
  });

  it("YOZISH: faqat yetishmaganlar, stavka surati bilan; mavjud qatorlar o'zgarmaydi", async () => {
    const report = await run(apply(2));

    expect(report.created).toBe(4);
    expect(report.created_cents).toBe(1061728);
    const rows = await earnings();
    expect(rows).toEqual([
      {
        order_id: '101',
        operator_id: '10',
        market_id: '1',
        amount: '5000.00',
        commission_type: 'percent',
        commission_value: '5.00',
        order_total_price: '100000.00',
        is_deleted: false,
      },
      {
        order_id: '102',
        operator_id: '10',
        market_id: '1',
        amount: '617.28',
        commission_type: 'percent',
        commission_value: '5.00',
        order_total_price: '12345.50',
        is_deleted: false,
      },
      {
        order_id: '103',
        operator_id: '11',
        market_id: '2',
        amount: '3000.00',
        commission_type: 'fixed',
        commission_value: '3000.00',
        order_total_price: '50000.00',
        is_deleted: false,
      },
      // 107 — eski qator o'zgarmagan.
      {
        order_id: '107',
        operator_id: '10',
        market_id: '1',
        amount: '999.00',
        commission_type: 'fixed',
        commission_value: '999.00',
        order_total_price: '70000.00',
        is_deleted: false,
      },
      // 108 — faqat o'chirilgan qator, yangisi qo'shilmagan.
      {
        order_id: '108',
        operator_id: '10',
        market_id: '1',
        amount: '3500.00',
        commission_type: 'percent',
        commission_value: '5.00',
        order_total_price: '70000.00',
        is_deleted: true,
      },
      {
        order_id: '110',
        operator_id: '13',
        market_id: '1',
        amount: '2000.00',
        commission_type: 'percent',
        commission_value: '10.00',
        order_total_price: '20000.00',
        is_deleted: false,
      },
    ]);

    // Audit: har (market, operator) va paket uchun bitta qator, run_id bilan.
    const audit = await logs();
    expect(audit.length).toBeGreaterThanOrEqual(3);
    for (const row of audit) {
      expect(row).toMatchObject({
        entity_type: 'OperatorEarning',
        action: 'created',
        user_role: 'system',
        service: 'finance-service',
      });
      expect(row.metadata).toMatchObject({
        reason: 'backfill',
        source: 'ops-script',
        run_id: report.run_id,
      });
      expect(row.description).toContain(`Operator #${row.entity_id}`);
      expect(row.metadata.earning_ids).toHaveLength(row.new_value.created);
    }
    expect(audit.flatMap((row) => row.metadata.order_ids).sort()).toEqual([
      '101',
      '102',
      '103',
      '110',
    ]);
    expect(
      audit.reduce(
        (sum, row) => sum + Math.round(row.new_value.amount * 100),
        0,
      ),
    ).toBe(1061728);
  });

  it("qayta yurgizish: yangi qator ham, audit ham yo'q", async () => {
    const rowsBefore = await earnings();
    const auditBefore = await logs();

    const report = await run(apply(1));

    expect(report.planned).toBe(0);
    expect(report.created).toBe(0);
    expect(report.stats.already_recorded).toBe(5); // 101,102,103,107,110
    expect(await earnings()).toEqual(rowsBefore);
    expect(await logs()).toEqual(auditBefore);
  });

  it("jonli yozuv bilan poyga: ikkinchi qator yo'q, hisobotda farq ko'rinadi", async () => {
    await db.query(
      `INSERT INTO ${O}.orders (id, market_id, operator_id, total_price, status)
       VALUES (114, 1, 10, 40000, 'sold'), (115, 1, 10, 60000, 'sold')`,
    );
    // Nomzodlar tanlangandan KEYIN, INSERT'dan oldin jonli yo'l 114 ga yozadi.
    let raced = false;
    const racing = new Proxy(runner, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (text: string, params?: unknown[]): Promise<unknown> => {
            if (
              !raced &&
              text.includes('INSERT INTO') &&
              text.includes('operator_earnings')
            ) {
              raced = true;
              await db.query(
                `INSERT INTO ${F}.operator_earnings
                   (operator_id, order_id, market_id, amount, commission_type, commission_value, order_total_price)
                 VALUES (10, 114, 1, 2000, 'percent', 5, 40000)`,
              );
            }
            return (await target.query(text, params)) as unknown;
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const report = await run(apply(10), racing);

    expect(raced).toBe(true);
    expect(report.planned).toBe(2);
    expect(report.created).toBe(1);
    const live = (await earnings()).filter((r) => r.order_id === '114');
    expect(live).toHaveLength(1);
    expect(live[0].amount).toBe('2000.00');
    const added = (await earnings()).filter((r) => r.order_id === '115');
    expect(added).toEqual([
      expect.objectContaining({ amount: '3000.00', is_deleted: false }),
    ]);
    const lastAudit = (await logs()).filter(
      (row) => row.metadata.run_id === report.run_id,
    );
    expect(lastAudit.flatMap((row) => row.metadata.order_ids)).toEqual(['115']);
  });

  it("ikkinchi nusxa ishlayotgan bo'lsa YOZISH rad etiladi (DRY-RUN ishlaydi)", async () => {
    await db.query(
      `INSERT INTO ${O}.orders (id, market_id, operator_id, total_price, status)
       VALUES (116, 1, 10, 10000, 'sold')`,
    );
    const other = db.createQueryRunner();
    await other.connect();
    try {
      await other.query(
        `SELECT pg_advisory_lock(hashtext('elchi:backfill-operator-earnings'))`,
      );
      await expect(run(apply())).rejects.toThrow('boshqa nusxa ishlayapti');
      expect((await earnings()).some((r) => r.order_id === '116')).toBe(false);

      const preview = await run();
      expect(preview.planned).toBe(1);
    } finally {
      await other.query(
        `SELECT pg_advisory_unlock(hashtext('elchi:backfill-operator-earnings'))`,
      );
      await other.release();
    }
    // Qulf bo'shagach — yoziladi.
    const report = await run(apply());
    expect(report.created).toBe(1);
  });
});
