import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { FinanceDailyService } from '../aggregates/finance-daily.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinanceCashboxDaily } from '../entities/finance-cashbox-daily.entity';
import { FinanceDailySnapshot } from '../entities/finance-daily-snapshot.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { Shift } from '../entities/shift.entity';
import { AdvisorInputsService } from './advisor-inputs.service';

/**
 * BE-5 — `finance.advisor.rule_inputs` haqiqiy Postgres'da (R1, R3, R6).
 * Spec o'z vaqtinchalik bazasini yaratadi (`FINANCE_PG_TEST_URI` — faqat
 * ulanish uchun), jadvallar entity'dan `finance_schema` ga.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const T = (s: string) => new Date(s);
const NOW = T('2026-10-22T09:00:00.000Z'); // 14:00 Toshkent

describePg('AdvisorInputsService — haqiqiy Postgres (BE-5)', () => {
  const dbName = `spec_advisor_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let svc: AdvisorInputsService;
  const identitySend = jest.fn((_p: unknown, data: { ids: string[] }) =>
    of({
      data: data.ids.map((id) => ({
        id,
        name: `User ${id}`,
        phone: '+998901234567',
      })),
    }),
  );
  const branchSend = jest.fn((_p: unknown, data: { id: string }) =>
    of({ data: { id: data.id, name: `Filial ${data.id}` } }),
  );

  beforeAll(async () => {
    const url = new URL(pgUri!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('FINANCE_PG_TEST_URI faqat lokal bo‘lishi kerak');
    }
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url.pathname = `/${dbName}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        CashboxExpenseCategory,
        FinancialBalanceHistory,
        FinanceCashboxDaily,
        FinanceDailySnapshot,
      ],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
    await db.synchronize();
    svc = new AdvisorInputsService(
      db,
      new FinanceDailyService(db),
      { send: identitySend } as never,
      { send: branchSend } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await db.query(
      'TRUNCATE "finance_schema"."shifts", "finance_schema"."cashbox_history", "finance_schema"."cashboxes", "finance_schema"."cashbox_expense_categories", "finance_schema"."financial_balance_history" RESTART IDENTITY CASCADE',
    );
  });

  async function shift(
    owner: string | null,
    closedAt: string,
    dCash: number | null,
    dCard: number | null,
    extra: { closed_by?: string | null; system?: boolean } = {},
  ): Promise<string> {
    const [row] = await db.query<Array<{ id: string }>>(
      `INSERT INTO "finance_schema"."shifts"
         ("cashbox_user_id", "opened_at", "closed_at", "status", "closed_by", "closed_by_system",
          "expected_balance_cash", "expected_balance_card", "discrepancy_cash", "discrepancy_card")
       VALUES ($1, $2::timestamptz - INTERVAL '8 hours', $2, 'closed', $3, $4, 1000000, 500000, $5, $6)
       RETURNING "id"::text AS id`,
      [
        owner,
        closedAt,
        extra.closed_by ?? '214',
        extra.system ?? false,
        dCash,
        dCard,
      ],
    );
    return row.id;
  }

  const r1 = (
    since: string,
    t = { shortage_uzs: 50000, consecutive_negative: 3 },
  ) =>
    svc.ruleInputs({
      rules: ['R1'],
      now: NOW.toISOString(),
      thresholds: { R1: t },
      since: { R1: since },
    });

  describe('R1', () => {
    beforeEach(async () => {
      await db.query(
        `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('branch', 7), ('main', 0)`,
      );
    });

    it('bitta smena < −50 000 → single_shortage; −50 000 aynan — yo‘q; NULL qism sanalmagan', async () => {
      const a = await shift('7', '2026-10-22T08:40:00Z', -120000, null);
      await shift('7', '2026-10-22T08:30:00Z', -50000, 0); // chegarada — fakt emas
      const out = await r1('2026-10-22T08:00:00Z');
      expect(out.candidates).toHaveLength(1);
      const c = out.candidates[0];
      expect(c).toMatchObject({
        rule_key: 'R1',
        dedup_key: 'R1:cashbox:7',
        fact_keys: [{ fact_key: a, fact_at: '2026-10-22T08:40:00.000Z' }],
        branch: { id: '7', name: 'Filial 7' },
        subject: { kind: 'cashbox', id: '7', name: 'Filial 7 kassasi' },
        headline_amount: -120000,
      });
      expect(c.facts).toMatchObject({
        trigger: 'single_shortage',
        shifts_count: 1,
        total_difference: -120000,
        last_difference: -120000,
        last_shift_id: a,
        closed_by: [{ id: '214', name: 'User 214' }],
      });
      const row = (c.evidence.rows as Array<Record<string, unknown>>)[0];
      expect(row).toMatchObject({
        counted_cash: 880000,
        counted_card: null, // sanalmagan
        expected: 1000000, // faqat sanalgan qism
        counted: 880000,
        difference: -120000,
        href: `/payments/shifts/${a}`,
      });
      expect(out.cursors.R1).toBe('2026-10-22T08:40:00.000Z');
      // PII yo'q.
      expect(JSON.stringify(out)).not.toContain('+998');
    });

    it('3 ta mos smena ketma-ket manfiy → consecutive_negative; avtomatik yopilgan (NULL) ketma-ketlikni uzmaydi', async () => {
      const s1 = await shift('0', '2026-10-20T15:50:00Z', -10000, 0);
      await shift('0', '2026-10-21T15:50:00Z', null, null, {
        closed_by: null,
        system: true,
      });
      const s2 = await shift('0', '2026-10-21T16:50:00Z', 0, -20000);
      const s3 = await shift('0', '2026-10-22T08:40:00Z', -5000, -1000);
      const out = await r1('2026-10-22T08:00:00Z');
      expect(out.candidates).toHaveLength(1);
      const c = out.candidates[0];
      expect(c.dedup_key).toBe('R1:cashbox:0');
      expect(c.fact_keys.map((f) => f.fact_key)).toEqual([s1, s2, s3]);
      expect(c.branch).toBeNull();
      expect(c.facts).toMatchObject({
        trigger: 'consecutive_negative',
        cashbox: { type: 'main', owner_id: '0', name: 'Asosiy kassa' },
        shifts_count: 3,
        total_difference: -36000,
        last_difference: -6000,
      });
      expect(c.headline_amount).toBe(-36000);
      expect(c.evidence).toMatchObject({
        kind: 'shifts',
        totals: { count: 3, difference: -36000 },
      });
    });

    it('streak eskirgan (yangi smena oynada emas) — nomzod yo‘q; musbat smena streakni uzadi', async () => {
      await shift('0', '2026-10-19T15:50:00Z', -10000, 0);
      await shift('0', '2026-10-20T15:50:00Z', -10000, 0);
      await shift('0', '2026-10-21T15:50:00Z', -10000, 0);
      expect((await r1('2026-10-22T08:00:00Z')).candidates).toEqual([]);
      await shift('0', '2026-10-22T08:40:00Z', 3000, 0);
      expect((await r1('2026-10-22T08:00:00Z')).candidates).toEqual([]);
    });

    it('yangi chegara (200 000) qo‘llanadi', async () => {
      await shift('7', '2026-10-22T08:40:00Z', -120000, null);
      const out = await r1('2026-10-22T08:00:00Z', {
        shortage_uzs: 200000,
        consecutive_negative: 3,
      });
      expect(out.candidates).toEqual([]);
    });
  });

  describe('R3', () => {
    let cat: string;
    let cashbox: string;

    beforeEach(async () => {
      [{ id: cat }] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashbox_expense_categories" ("name") VALUES ('Yoqilg‘i') RETURNING "id"::text AS id`,
      );
      [{ id: cashbox }] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('branch', 9) RETURNING "id"::text AS id`,
      );
    });

    async function expense(
      amount: number,
      at: string,
      cb = cashbox,
    ): Promise<string> {
      const [row] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashbox_history"
           ("operation_type", "cashbox_id", "source_type", "amount", "balance_after",
            "expense_category_id", "expense_category_name", "created_by", "createdAt")
         VALUES ('expense', $1, 'manual_expense', $2, 0, $3, 'Yoqilg‘i', 301, $4)
         RETURNING "id"::text AS id`,
        [cb, amount, cat, at],
      );
      return row.id;
    }

    const run = () =>
      svc.ruleInputs({
        rules: ['R3'],
        now: NOW.toISOString(),
        thresholds: { R3: { mad_multiplier: 3 } },
        since: { R3: '2026-10-22T00:00:00Z' },
      });

    it('mediana + 3×MAD dan katta → nomzod; statistika joriy qatorsiz, filial+kategoriya', async () => {
      for (const [i, a] of [
        400000, 420000, 380000, 450000, 410000, 430000,
      ].entries()) {
        await expense(
          a,
          `2026-10-${String(10 + i).padStart(2, '0')}T08:00:00Z`,
        );
      }
      const big = await expense(1450000, '2026-10-22T08:00:00Z');
      await expense(450000, '2026-10-22T08:10:00Z'); // odatiy — nomzod emas
      const out = await run();
      expect(out.candidates).toHaveLength(1);
      const c = out.candidates[0];
      expect(c.dedup_key).toBe(`R3:history:${big}`);
      expect(c.facts).toMatchObject({
        amount: 1450000,
        category: { id: cat, name: 'Yoqilg‘i' },
        median: 415000,
        mad: 15000,
        // BQ9: max(MAD 15 000, 415 000 × 5% = 20 750) → 415 000 + 3 × 20 750.
        threshold: 477250,
        ratio_to_median: 3.5,
        sample_size: 6,
        window_days: 30,
        scope: 'category_branch',
        created_by: { id: '301', name: 'User 301' },
      });
      expect(c.evidence).toMatchObject({
        kind: 'expense_stats',
        total_rows: 7,
      });
      expect(out.cursors.R3).toBe('2026-10-22T08:10:00.000Z');
    });

    it('namuna < 5 — jim (Q18); filial kam bo‘lsa butun tizim (Q24)', async () => {
      for (const d of ['10', '11', '12'])
        await expense(400000, `2026-10-${d}T08:00:00Z`);
      await expense(1450000, '2026-10-22T08:00:00Z');
      expect((await run()).candidates).toEqual([]);

      const [{ id: other }] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('branch', 10) RETURNING "id"::text AS id`,
      );
      for (const d of ['13', '14'])
        await expense(400000, `2026-10-${d}T08:00:00Z`, other);
      const out = await run();
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0].facts).toMatchObject({
        scope: 'category',
        sample_size: 5,
      });
    });

    it('BQ9: MAD = 0 (bir xil summalar) — minimal MAD = mediana × 5%', async () => {
      for (const d of ['10', '11', '12', '13', '14'])
        await expense(400000, `2026-10-${d}T08:00:00Z`);
      await expense(450000, '2026-10-22T08:00:00Z'); // 400k + 3×20k = 460k dan kichik
      expect((await run()).candidates).toEqual([]);
      const big = await expense(470000, '2026-10-22T08:05:00Z');
      const out = await run();
      expect(out.candidates.map((c) => c.dedup_key)).toEqual([
        `R3:history:${big}`,
      ]);
      expect(out.candidates[0].facts).toMatchObject({
        mad: 0,
        threshold: 460000,
      });
    });
  });

  describe('R6', () => {
    async function ledger(amount: number, at: string) {
      await db.query(
        `INSERT INTO "finance_schema"."financial_balance_history"
           ("amount", "balance_before", "balance_after", "source_type", "createdAt")
         VALUES ($1, 0, 0, 'manual_expense', $2)`,
        [amount, at],
      );
    }

    it('zararli kun va hafta → nomzod; foydali kun — yo‘q; bugungi kun tekshirilmaydi', async () => {
      await ledger(500000, '2026-10-20T05:00:00Z');
      await ledger(-880000, '2026-10-20T10:00:00Z'); // 20.10: −380 000
      await ledger(900000, '2026-10-21T05:00:00Z'); // 21.10: +900 000
      const out = await svc.ruleInputs({
        rules: ['R6'],
        now: NOW.toISOString(),
        thresholds: {},
        since: {},
        periods: {
          days: ['2026-10-20', '2026-10-21', '2026-10-22'],
          weeks: ['2026-10-12'],
        },
      });
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0]).toMatchObject({
        dedup_key: 'R6:day:2026-10-20',
        fact_keys: [{ fact_key: 'R6:day:2026-10-20' }],
        subject: { kind: 'system', id: null },
        headline_amount: -380000,
        facts: {
          period: 'day',
          from: '2026-10-20',
          to: '2026-10-20',
          income: 500000,
          expense: 880000,
          net: -380000,
        },
      });

      const week = await svc.ruleInputs({
        rules: ['R6'],
        now: '2026-10-27T00:00:00Z',
        thresholds: {},
        since: {},
        periods: { weeks: ['2026-10-19'] },
      });
      // Hafta: −380 000 + 900 000 > 0 → zarar yo'q.
      expect(week.candidates).toEqual([]);
    });
  });
});
