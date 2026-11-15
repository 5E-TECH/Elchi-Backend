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
import { ShiftAccountCheck } from '../entities/shift-account-check.entity';
import { CashboxReceipt } from '../entities/cashbox-receipt.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { PaymentCorrection } from '../entities/payment-correction.entity';
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
  const branchSend = jest.fn(
    (p: { cmd: string }, data: { id?: string; user_ids?: string[] }) =>
      p.cmd === 'branch.user.find_by_user_ids'
        ? of({
            data: (data.user_ids ?? []).map((u) => ({
              user_id: u,
              branch: { id: '1', name: 'Toshkent HQ' },
            })),
          })
        : of({ data: { id: data.id, name: `Filial ${data.id}` } }),
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
        ShiftAccountCheck,
        CashboxReceipt,
        CashboxCard,
        PaymentCorrection,
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
      'TRUNCATE "finance_schema"."shifts", "finance_schema"."cashbox_history", "finance_schema"."cashboxes", "finance_schema"."cashbox_expense_categories", "finance_schema"."financial_balance_history", "finance_schema"."finance_cashbox_daily", "finance_schema"."shift_account_checks", "finance_schema"."cashbox_receipts", "finance_schema"."cashbox_cards", "finance_schema"."payment_corrections" RESTART IDENTITY CASCADE',
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

    it('round-2 S1: orqa oynada TUGAGAN ketma-ketlik ham topiladi; uzunligi — butun manfiy qator', async () => {
      const s1 = await shift('0', '2026-10-17T15:50:00Z', -1000, 0);
      const s2 = await shift('0', '2026-10-18T15:50:00Z', -1000, 0);
      const s3 = await shift('0', '2026-10-19T15:50:00Z', -1000, 0);
      await shift('0', '2026-10-20T15:50:00Z', 5000, 0);
      const out = await r1('2026-10-15T09:00:00Z'); // 7 kunlik backfill
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0].fact_keys.map((f) => f.fact_key)).toEqual([
        s1,
        s2,
        s3,
      ]);
      expect(out.candidates[0].facts).toMatchObject({
        trigger: 'consecutive_negative',
        streak_length: 3,
        streak_total: -3000,
      });
    });

    it('round-2: davom etayotgan ketma-ketlik — fakt_keys amount bilan, streak_length = butun qator', async () => {
      await shift('0', '2026-10-18T15:50:00Z', -10000, 0);
      await shift('0', '2026-10-19T15:50:00Z', -10000, 0);
      await shift('0', '2026-10-20T15:50:00Z', -10000, 0);
      await shift('0', '2026-10-21T15:50:00Z', -10000, 0);
      const s5 = await shift('0', '2026-10-22T08:40:00Z', -20000, 0);
      const out = await r1('2026-10-22T08:00:00Z');
      const c = out.candidates[0];
      expect(c.fact_keys.map((f) => f.amount)).toEqual([
        -10000, -10000, -20000,
      ]);
      expect(c.facts).toMatchObject({
        trigger: 'consecutive_negative',
        last_shift_id: s5,
        shifts_count: 3,
        streak_length: 5,
        streak_total: -60000,
      });
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
      // round-2 S2: boshqa filial qatorlari O'Z kassasi nomi/egasi bilan.
      const rows = out.candidates[0].evidence.rows as Array<{
        cashbox_name: string | null;
        cashbox: { owner_id: string };
      }>;
      expect(rows.map((r) => r.cashbox.owner_id).sort()).toEqual([
        '10',
        '10',
        '9',
        '9',
        '9',
        '9',
      ]);
      expect(
        rows
          .filter((r) => r.cashbox.owner_id === '10')
          .map((r) => r.cashbox_name),
      ).toEqual(['Filial 10 kassasi', 'Filial 10 kassasi']);
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

  describe('R2/R4/R5 (epizod)', () => {
    async function cashbox(
      type: string,
      owner: number,
      balance: number,
    ): Promise<string> {
      const [row] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id", "balance")
         VALUES ($1, $2, $3) RETURNING "id"::text AS id`,
        [type, owner, balance],
      );
      return row.id;
    }
    async function hist(
      cb: string,
      op: 'income' | 'expense',
      source: string,
      amount: number,
      balanceAfter: number,
      at: string,
      reverses: string | null = null,
    ): Promise<string> {
      const [row] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashbox_history"
           ("operation_type", "cashbox_id", "source_type", "amount", "balance_after", "createdAt", "reverses_history_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "id"::text AS id`,
        [op, cb, source, amount, balanceAfter, at, reverses],
      );
      return row.id;
    }
    async function daily(
      cb: string,
      owner: number,
      day: string,
      closing: number,
    ) {
      await db.query(
        `INSERT INTO "finance_schema"."finance_cashbox_daily"
           ("snapshot_date", "cashbox_id", "cashbox_type", "user_id", "opening_balance", "closing_balance", "income")
         VALUES ($1, $2, 'couriers', $3, 0, $4, 0)`,
        [day, cb, owner, closing],
      );
    }
    const run = (rules: Array<'R2' | 'R4' | 'R5'>, now = NOW.toISOString()) =>
      svc.ruleInputs({
        rules,
        now,
        thresholds: {
          R2: { balance_uzs: 2000000, growth_days: 3, no_handover_days: 3 },
          R4: { days_without_payout: 7 },
          R5: { balance_uzs: 5000000, days_without_transfer: 3 },
        },
        since: {},
      });

    it('R2 (b): > 3 kun topshirilmagan; epizod = oxirgi topshirish; T6 qaytarilgan topshirish sanalmaydi', async () => {
      const cb = await cashbox('couriers', 55, 2840000);
      const h1 = await hist(
        cb,
        'expense',
        'courier_payment',
        -500000,
        0,
        '2026-10-17T10:00:00Z',
      );
      // 18.10 dagi topshirish T6 bilan qaytarilgan — oxirgi topshirish h1 bo'lib qoladi.
      const h2 = await hist(
        cb,
        'expense',
        'courier_payment',
        -100000,
        0,
        '2026-10-18T10:00:00Z',
      );
      await hist(
        cb,
        'income',
        'payment_reversal',
        100000,
        100000,
        '2026-10-18T11:00:00Z',
        h2,
      );
      await hist(
        cb,
        'income',
        'courier_payment',
        100000,
        100000,
        '2026-10-20T10:00:00Z',
      ); // qabul tomoni emas
      const out = await run(['R2']);
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0]).toMatchObject({
        dedup_key: 'R2:courier:55',
        fact_keys: [
          { fact_key: `ep:h:${h1}`, fact_at: '2026-10-16T19:00:00.000Z' },
        ],
        branch: { id: '1', name: 'Toshkent HQ' },
        subject: { kind: 'courier', id: '55', name: 'User 55' },
        headline_amount: 2840000,
        facts: {
          trigger: 'no_handover',
          balance: 2840000,
          days_without_handover: 5,
          growth_days: 0,
        },
        evidence: {
          kind: 'courier_days',
          last_handover: { history_id: h1, amount: 500000 },
        },
      });
    });

    it('R2: aynan 3 kun — yo‘q (qat’iy katta); (a) o‘sish 3 yopilgan kun VA > 2 mln → growth', async () => {
      const cb = await cashbox('couriers', 56, 2500000);
      await hist(
        cb,
        'expense',
        'courier_payment',
        -1,
        0,
        '2026-10-19T10:00:00Z',
      ); // 3 kun oldin
      expect((await run(['R2'])).candidates).toEqual([]);
      for (const [d, v] of [
        ['2026-10-18', 100],
        ['2026-10-19', 200],
        ['2026-10-20', 300],
        ['2026-10-21', 400],
      ] as const) {
        await daily(cb, 56, d, v);
      }
      const out = await run(['R2']);
      expect(out.candidates[0].facts).toMatchObject({
        trigger: 'growth',
        growth_days: 3,
      });
      expect((out.candidates[0].evidence.rows as unknown[]).length).toBe(4);
    });

    it('round-2 #652 B1: o‘sish + BUGUN topshirish — yangi epizod ochilmaydi (ayni holat)', async () => {
      const cb = await cashbox('couriers', 58, 3500000);
      const h20 = await hist(
        cb,
        'expense',
        'courier_payment',
        -100000,
        1500000,
        '2026-10-20T10:00:00Z',
      );
      for (const [d, v] of [
        ['2026-10-18', 1600000],
        ['2026-10-19', 2100000],
        ['2026-10-20', 2600000],
        ['2026-10-21', 3200000],
      ] as const) {
        await daily(cb, 58, d, v);
      }
      const before = await run(['R2']);
      expect(before.candidates[0]).toMatchObject({
        fact_keys: [{ fact_key: `ep:h:${h20}` }],
        facts: { trigger: 'growth' },
      });
      // 22.10 08:30Z: 1,2 mln topshirildi (qoldiq 2,3 mln) — bugungi epizod.
      await hist(
        cb,
        'expense',
        'courier_payment',
        -1200000,
        2300000,
        '2026-10-22T08:30:00Z',
      );
      await db.query(
        `UPDATE "finance_schema"."cashboxes" SET "balance" = 2300000 WHERE "id" = $1`,
        [cb],
      );
      expect((await run(['R2'])).candidates).toEqual([]);
    });

    it('R2 (a): oynada kun yetishmasa (snapshot yo‘q) — o‘sish tekshirilmaydi', async () => {
      const cb = await cashbox('couriers', 57, 2500000);
      await hist(
        cb,
        'expense',
        'courier_payment',
        -1,
        0,
        '2026-10-21T10:00:00Z',
      );
      for (const [d, v] of [
        ['2026-10-18', 100],
        ['2026-10-19', 200],
        ['2026-10-21', 400],
      ] as const) {
        await daily(cb, 57, d, v);
      }
      expect((await run(['R2'])).candidates).toEqual([]);
    });

    it('R4: qarz > 0 VA > 7 kun to‘lov yo‘q; to‘lov hech bo‘lmasa — qarz boshlangan kun', async () => {
      const m1 = await cashbox('markets', 70, 3120000);
      await hist(
        m1,
        'expense',
        'market_payment',
        -800000,
        0,
        '2026-10-13T10:00:00Z',
      );
      const m2 = await cashbox('markets', 71, 50000);
      await hist(m2, 'income', 'sell', 50000, 50000, '2026-10-10T10:00:00Z');
      const m3 = await cashbox('markets', 72, 0); // qarz yo'q
      await hist(m3, 'income', 'sell', 50000, 50000, '2026-10-01T10:00:00Z');
      const out = await run(['R4']);
      expect(
        out.candidates.map((c) => [
          c.dedup_key,
          c.fact_keys[0].fact_key,
          c.facts.days_without_payout,
        ]),
      ).toEqual([
        ['R4:market:70', expect.stringMatching(/^ep:h:\d+$/), 9],
        ['R4:market:71', 'ep:d:2026-10-10', 12],
      ]);
      expect(out.candidates[0].facts).toMatchObject({
        debt: 3120000,
        last_payout_amount: 800000,
        market: { id: '70', name: 'User 70' },
      });
    });

    it('R5: > 5 mln VA > 3 kun HQ’ga o‘tkazma yo‘q (VA); dalil — o‘tkazmalar', async () => {
      const b = await cashbox('branch', 12, 6400000);
      const t1 = await hist(
        b,
        'expense',
        'branch_to_main',
        -2000000,
        100,
        '2026-10-18T10:00:00Z',
      );
      const low = await cashbox('branch', 13, 4000000);
      await hist(
        low,
        'expense',
        'branch_to_main',
        -1,
        0,
        '2026-10-01T10:00:00Z',
      );
      const out = await run(['R5']);
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0]).toMatchObject({
        dedup_key: 'R5:branch:12',
        fact_keys: [{ fact_key: `ep:h:${t1}` }],
        branch: { id: '12', name: 'Filial 12' },
        subject: { kind: 'branch', id: '12', name: 'Filial 12' },
        facts: {
          balance: 6400000,
          days_without_transfer: 4,
          last_transfer_amount: 2000000,
        },
        evidence: {
          kind: 'branch_transfers',
          transfers: [{ history_id: t1, amount: 2000000 }],
        },
      });
    });
  });

  describe('R7/R8', () => {
    const runR7 = (since: string, now = NOW.toISOString()) =>
      svc.ruleInputs({
        rules: ['R7'],
        now,
        thresholds: {},
        since: { R7: since },
      });

    describe('R7 karta', () => {
      let card = '';
      beforeEach(async () => {
        await db.query(
          `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('main', 0)`,
        );
        [{ id: card }] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."cashbox_cards" ("cashbox_id", "name", "last4") VALUES (1, 'Humo virtual', '1234') RETURNING "id"::text AS id`,
        );
      });
      const check = async (o: {
        status?: string;
        confirmed?: string | null;
        checked?: string;
        entered?: number;
        read?: number;
        expected?: number;
        last4?: string | null;
      }) => {
        const [{ id: shiftId }] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."shifts" ("cashbox_user_id", "opened_at", "closed_at", "status")
           VALUES (NULL, '2026-10-21T03:00:00Z', '2026-10-21T15:00:00Z', 'closed') RETURNING "id"::text AS id`,
        );
        const [row] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."shift_account_checks"
             ("shift_id", "cashbox_card_id", "entered_balance", "ai_read_balance", "expected_balance",
              "ai_status", "ai_checked_at", "confirmed_at", "ai_confidence", "ai_last4_detected")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0.9, $9) RETURNING "id"::text AS id`,
          [
            shiftId,
            card,
            o.entered ?? 1540000,
            o.read ?? 1522000,
            o.expected ?? 1540000,
            o.status ?? 'mismatch',
            o.checked ?? '2026-10-22T08:30:00Z',
            o.confirmed === undefined ? '2026-10-22T08:30:00Z' : o.confirmed,
            o.last4 === undefined ? '1234' : o.last4,
          ],
        );
        return { id: row.id, shiftId };
      };

      it('kassir xatosi: farq = o‘qilgan − kiritilgan, tizim farqi ham; qoralama va match — yo‘q', async () => {
        const ok = await check({});
        await check({ confirmed: null }); // qoralama
        await check({ status: 'match' });
        const out = await runR7('2026-10-22T08:00:00Z');
        expect(out.candidates).toHaveLength(1);
        expect(out.candidates[0]).toMatchObject({
          dedup_key: `R7:card_check:${ok.id}`,
          fact_keys: [{ fact_at: '2026-10-21T15:00:00.000Z' }],
          headline_amount: -18000,
          facts: {
            source: 'card_balance',
            mismatch: ['amount'],
            entered_amount: 1540000,
            read_amount: 1522000,
            difference: -18000,
            expected_balance: 1540000,
            system_difference: -18000,
            shift: { id: ok.shiftId, date: '2026-10-21' },
            card: { id: card, name: 'Humo virtual' },
            cashbox: { type: 'main', name: 'Asosiy kassa' },
          },
          evidence: {
            kind: 'card_balance_check',
            expected_balance: 1540000,
            ai_confidence: 0.9,
          },
        });
      });

      it('⭐ B1: AI natijasi smena ochiq paytda, tasdiq tick’dan keyin — keyingi tick topadi', async () => {
        const c = await check({
          checked: '2026-10-22T08:00:00Z',
          confirmed: null,
        });
        const first = await runR7(
          '2026-10-22T07:55:00Z',
          '2026-10-22T08:30:00Z',
        );
        expect(first.candidates).toEqual([]);
        expect(first.cursors.R7).toBeNull(); // dvigatel `now` (08:30) saqlaydi
        await db.query(
          `UPDATE "finance_schema"."shift_account_checks" SET "confirmed_at" = '2026-10-22T08:40:00Z' WHERE "id" = $1`,
          [c.id],
        );
        const next = await runR7(
          '2026-10-22T08:25:00Z',
          '2026-10-22T09:00:00Z',
        );
        expect(next.candidates.map((x) => x.dedup_key)).toEqual([
          `R7:card_check:${c.id}`,
        ]);
        expect(next.cursors.R7).toBe('2026-10-22T08:40:00.000Z');
      });

      it('⭐ B3: halol kassir (kiritilgan = o‘qilgan), tizimda farq — headline tizim farqi; boshqa karta rasmi — card', async () => {
        await check({ entered: 950000, read: 950000, expected: 1000000 });
        await check({
          entered: 1000000,
          read: 1000000,
          expected: 1000000,
          last4: '9999',
        });
        // Ega qarori: kassir xatosi (kiritilgan ≠ AI), lekin AI = tizim — 'amount' emas.
        await check({
          entered: 1100000,
          read: 1000000,
          expected: 1000000,
          last4: '9999',
        });
        const out = await runR7('2026-10-22T08:00:00Z');
        expect(
          out.candidates.map((c) => [
            c.facts.mismatch,
            c.headline_amount,
            c.facts.difference,
            c.facts.system_difference,
          ]),
        ).toEqual([
          [['amount'], -50000, 0, -50000],
          [['card'], null, 0, 0],
          [['card'], null, -100000, 0],
        ]);
      });
    });

    describe('R7 chek', () => {
      let cb = '';
      let hist = '';
      beforeEach(async () => {
        [{ id: cb }] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('branch', 9) RETURNING "id"::text AS id`,
        );
        hist = await histRow(
          cb,
          'expense',
          'manual_expense',
          '2026-10-22T06:05:00Z',
        );
      });
      async function histRow(
        cashbox: string,
        op: string,
        source: string,
        at: string,
        amount = 350000,
      ): Promise<string> {
        const [row] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."cashbox_history"
             ("operation_type", "cashbox_id", "source_type", "amount", "balance_after", "expense_category_name", "created_by", "createdAt")
           VALUES ($1, $2, $3, $4, 0, 'Yoqilg‘i', 301, $5) RETURNING "id"::text AS id`,
          [op, cashbox, source, amount, at],
        );
        return row.id;
      }
      const receipt = async (o: {
        state?: string;
        status?: string;
        flags?: string[] | null;
        deleted?: boolean;
        history?: string | null;
        counter?: string | null;
        kind?: string;
        branchId?: string | null;
        currency?: string | null;
        errorReason?: string | null;
        amount?: number;
        difference?: number | null;
        date?: string;
      }) => {
        const [row] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."cashbox_receipts"
             ("kind", "state", "history_id", "counter_history_id", "branch_id", "file_key", "file_sha256", "mime", "size_bytes", "uploaded_by",
              "ai_status", "ai_flags", "entered_amount", "ai_amount", "ai_difference", "ai_currency", "ai_error_reason", "ai_date",
              "ai_recipient", "ai_recipient_last4", "ai_payer", "ai_payer_last4", "ai_checked_at", "updatedAt", "is_deleted")
           VALUES ($1, $2, $3, $4, $5, 'k', repeat('a', 64), 'image/jpeg', 1, 301, $6, $7::jsonb,
                   350000, $8, $9, $10, $11, $12, 'ALIYEV ALI', '8840', 'VALIYEV VALI', '3307', '2026-10-22T08:40:00Z', '2026-10-22T08:40:00Z', $13)
           RETURNING "id"::text AS id`,
          [
            o.kind ?? 'manual_expense',
            o.state ?? 'linked',
            o.history === undefined ? hist : o.history,
            o.counter ?? null,
            o.branchId ?? null,
            o.status ?? 'mismatch',
            o.flags ? JSON.stringify(o.flags) : null,
            o.amount ?? 332000,
            o.difference === undefined ? -18000 : o.difference,
            o.currency ?? null,
            o.errorReason ?? null,
            o.date ?? '22.10.2026 11:05',
            o.deleted ?? false,
          ],
        );
        return row.id;
      };

      it('bog‘langan mismatch / card_mismatch; qoralama, o‘chirilgan, match — yo‘q; PII ism saqlanmaydi', async () => {
        const a = await receipt({ flags: ['card_mismatch'] });
        await receipt({ state: 'draft', history: null });
        await receipt({ deleted: true, history: null });
        await receipt({ status: 'match', history: null });
        const b = await receipt({
          status: 'match',
          flags: ['card_mismatch'],
          history: null,
        });
        const out = await runR7('2026-10-22T08:00:00Z');
        expect(out.candidates.map((c) => c.dedup_key)).toEqual([
          `R7:receipt:${a}`,
          `R7:receipt:${b}`,
        ]);
        expect(out.candidates[0]).toMatchObject({
          branch: { id: '9', name: 'Filial 9' },
          fact_keys: [{ fact_at: '2026-10-22T06:05:00.000Z' }],
          facts: {
            source: 'receipt',
            receipt_kind: 'manual_expense',
            mismatch: ['amount', 'card'],
            difference: -18000,
            read_currency: null,
            operation: {
              history_id: hist,
              kind: 'manual_expense',
              category_name: 'Yoqilg‘i',
            },
            created_by: { id: '301', name: 'User 301' },
          },
          evidence: {
            kind: 'receipt_check',
            receipt: {
              date: '22.10.2026 11:05',
              date_at: '2026-10-22T06:05:00.000Z',
              date_day: '2026-10-22',
              recipient: null,
              payer: null,
              recipient_last4: '8840',
              payer_last4: '3307',
            },
            week_summary: { from: '2026-10-19', to: '2026-10-25' },
          },
        });
        expect(JSON.stringify(out)).not.toMatch(/ALIYEV|VALIYEV/);
        expect(out.candidates[1].facts).toMatchObject({
          mismatch: ['card'],
          operation: null,
        });
      });

      it('⭐ B2: chek so‘mda emas — summa solishtirilmaydi (#643 dan oldin va keyin)', async () => {
        const pre = await receipt({
          currency: 'USD',
          amount: 100,
          difference: -1249900,
        });
        const post = await receipt({
          currency: 'USD',
          amount: 100,
          difference: null,
          errorReason: 'currency_not_uzs',
          history: null,
        });
        const out = await runR7('2026-10-22T08:00:00Z');
        for (const [i, id] of [pre, post].entries()) {
          expect(out.candidates[i]).toMatchObject({
            dedup_key: `R7:receipt:${id}`,
            headline_amount: null,
            facts: {
              mismatch: ['currency'],
              difference: null,
              read_amount: null,
              read_amount_original: 100,
              read_currency: 'USD',
            },
            evidence: {
              receipt: { amount: 100, currency: 'USD', date_at: null },
            },
          });
        }
      });

      it('S2/S3: o‘tkazma cheki — jo‘natuvchi filial; T6 bilan qaytarilgan operatsiya — yo‘q; T6 tahriri (updatedAt) ko‘rinadi', async () => {
        const [{ id: main }] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('main', 0) RETURNING "id"::text AS id`,
        );
        const income = await histRow(
          main,
          'income',
          'branch_to_main',
          '2026-10-22T06:00:00Z',
        );
        const out1 = await histRow(
          cb,
          'expense',
          'branch_to_main',
          '2026-10-22T06:00:00Z',
        );
        const tr = await receipt({
          kind: 'branch_to_hq',
          history: income,
          counter: out1,
          flags: ['card_mismatch'],
          status: 'match',
        });

        const reversedOp = await histRow(
          cb,
          'expense',
          'manual_expense',
          '2026-10-22T07:00:00Z',
          1,
        );
        await receipt({ history: reversedOp });
        await db.query(
          `INSERT INTO "finance_schema"."cashbox_history" ("operation_type", "cashbox_id", "source_type", "amount", "balance_after", "reverses_history_id", "createdAt")
           VALUES ('income', $1, 'payment_reversal', 1, 0, $2, '2026-10-22T07:30:00Z')`,
          [cb, reversedOp],
        );
        const out = await runR7('2026-10-22T08:00:00Z');
        expect(out.candidates.map((c) => c.dedup_key)).toEqual([
          `R7:receipt:${tr}`,
        ]);
        expect(out.candidates[0]).toMatchObject({
          branch: { id: '9' },
          subject: { kind: 'cashbox', id: '9' },
          facts: {
            receipt_kind: 'branch_to_hq',
            mismatch: ['card'],
            cashbox: { type: 'branch', owner_id: '9' },
            // round-2 #654: shartnoma enum — chek turi, source_type emas.
            operation: { history_id: income, kind: 'branch_to_hq' },
          },
        });

        // T6 tahriri: holat qayta hisoblandi, ai_checked_at eski, updatedAt yangi.
        const edited = await receipt({ status: 'match', history: null });
        await db.query(
          `UPDATE "finance_schema"."cashbox_receipts" SET "ai_status" = 'mismatch', "ai_checked_at" = '2026-10-20T08:00:00Z', "updatedAt" = '2026-10-22T08:50:00Z' WHERE "id" = $1`,
          [edited],
        );
        const later = await runR7('2026-10-22T08:45:00Z');
        expect(later.candidates.map((c) => c.dedup_key)).toContain(
          `R7:receipt:${edited}`,
        );
      });

      it('S5: receipt_ai_enabled — chek sozlamasidan (stub)', async () => {
        await receipt({});
        const withSettings = new AdvisorInputsService(
          db,
          new FinanceDailyService(db),
          { send: identitySend } as never,
          { send: branchSend } as never,
          {
            loadSettings: () =>
              Promise.resolve({
                manual_expense: { ai_enabled: false },
                hq_transfer: { ai_enabled: false },
              }),
          } as never,
        );
        const out = await withSettings.ruleInputs({
          rules: ['R7'],
          now: NOW.toISOString(),
          thresholds: {},
          since: { R7: '2026-10-22T08:00:00Z' },
        });
        expect(out.candidates[0].facts.receipt_ai_enabled).toBe(false);
      });
    });

    describe('R8', () => {
      beforeEach(async () => {
        await db.query(
          `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('main', 0), ('couriers', 5)`,
        );
      });
      // Buyurtma qaytarilishi: bitta buyurtma — bir nechta kassada oyoq.
      const corr = (
        at: string,
        sourceId: number | null,
        source = 'correction',
        cashbox = 1,
      ) =>
        db.query(
          `INSERT INTO "finance_schema"."cashbox_history" ("operation_type", "cashbox_id", "source_type", "source_id", "amount", "balance_after", "createdAt")
           VALUES ('income', $4, $1, $2, 1, 0, $3)`,
          [source, sourceId, at, cashbox],
        );
      const t6 = (action: string, at: string) =>
        db.query(
          `INSERT INTO "finance_schema"."payment_corrections"
             ("action", "payment_kind", "original_transfer_id", "root_transfer_id", "reversal_transfer_id",
              "original_amount", "payment_method", "counterparty_user_id", "receiver_cashbox_id", "reason",
              "created_by", "idempotency_key", "root_created_at", "createdAt")
           VALUES ($1, 'courier_payment', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'cash', 1, 1, 'x', 1,
                   gen_random_uuid()::text, now(), $2)`,
          [action, at],
        );
      const run = (t: Record<string, number>, weeks = ['2026-10-12']) =>
        svc.ruleInputs({
          rules: ['R8'],
          now: NOW.toISOString(),
          thresholds: { R8: t },
          since: {},
          periods: { weeks },
        });

      it('qo‘lda + T6 sanaladi, buyurtma qaytarilishi va payment_reversal yo‘q; ≥ max(min_count, 2× bazaviy)', async () => {
        await corr('2026-09-20T05:00:00Z', null);
        await corr('2026-10-01T05:00:00Z', null);
        await corr('2026-10-13T05:00:00Z', null);
        await corr('2026-10-14T05:00:00Z', null);
        await corr('2026-10-14T06:00:00Z', 500);
        await corr('2026-10-14T06:00:01Z', 500, 'correction', 2);
        await corr('2026-10-15T06:00:00Z', null, 'payment_reversal');
        await t6('reverse', '2026-10-15T05:00:00Z');
        await t6('edit', '2026-10-16T05:00:00Z');
        const out = await run({ ratio: 2, min_count: 3 });
        expect(out.candidates).toHaveLength(1);
        expect(out.candidates[0]).toMatchObject({
          dedup_key: 'R8:week:2026-10-12',
          subject: { kind: 'system', id: null, name: 'Butun tizim' },
          first_fact_at: '2026-10-11T19:00:00.000Z',
          facts: {
            from: '2026-10-12',
            to: '2026-10-18',
            count: 4,
            baseline_weekly_avg: 0.47,
            ratio: 8.5,
          },
          evidence: {
            kind: 'corrections',
            by_kind: {
              manual_correction: 2,
              order_rollback: 1,
              payment_reverse: 1,
              payment_edit: 1,
            },
            counted_kinds: [
              'manual_correction',
              'payment_reverse',
              'payment_edit',
            ],
            baseline: { window_days: 30, total: 2, min_count: 3, ratio: 2 },
          },
        });
        expect(
          (out.candidates[0].evidence.days as Array<{ count: number }>).map(
            (d) => d.count,
          ),
        ).toEqual([0, 1, 1, 1, 1, 0, 0]);
        // min_count 5 — jim; yuqori ratio — jim; tugamagan hafta — tekshirilmaydi.
        expect((await run({ ratio: 2, min_count: 5 })).candidates).toEqual([]);
        expect(
          (await run({ ratio: 10, min_count: 3 }, ['2026-10-12', '2026-10-19']))
            .candidates,
        ).toEqual([]);
      });

      it('baza 0: min_count yetsa ogohlantiradi, ratio null; S7 — butun sonli solishtiruv', async () => {
        for (const d of ['13', '14', '15'])
          await corr(`2026-10-${d}T05:00:00Z`, null);
        const zero = await run({ ratio: 2, min_count: 3 });
        expect(zero.candidates[0].facts).toMatchObject({
          count: 3,
          baseline_weekly_avg: 0,
          ratio: null,
        });

        // Baza 4 (30 kunda) → aniq chegara 4,3 × 4 × 7 / 30 = 4,0133: 4 ta — yetmaydi.
        await db.query(
          `TRUNCATE "finance_schema"."cashbox_history" RESTART IDENTITY CASCADE`,
        );
        for (const d of ['20', '21', '22', '23'])
          await corr(`2026-09-${d}T05:00:00Z`, null);
        for (const d of ['13', '14', '15', '16'])
          await corr(`2026-10-${d}T05:00:00Z`, null);
        expect((await run({ ratio: 4.3, min_count: 1 })).candidates).toEqual(
          [],
        );
        expect((await run({ ratio: 4, min_count: 1 })).candidates).toHaveLength(
          1,
        );
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
        subject: { kind: 'system', id: null, name: 'Butun tizim' },
        first_fact_at: '2026-10-19T19:00:00.000Z', // davr boshi (§5.1)
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

  it('round-2: bir qoida xatosi — `errors` da, boshqasi odatdagidek; since ≤ 30 kun', async () => {
    await db.query(
      `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('branch', 7)`,
    );
    await shift('7', '2026-10-22T08:40:00Z', -120000, null);
    await db.query(
      `ALTER TABLE "finance_schema"."cashbox_history" RENAME TO "cashbox_history_x"`,
    );
    try {
      const out = await svc.ruleInputs({
        rules: ['R1', 'R3'],
        now: NOW.toISOString(),
        thresholds: {},
        since: { R1: '2025-01-01T00:00:00Z', R3: '2026-10-22T00:00:00Z' },
      });
      expect(out.candidates.map((c) => c.rule_key)).toEqual(['R1']);
      expect(out.cursors.R3).toBeUndefined();
      expect(out.errors?.R3).toMatch(/cashbox_history/);
    } finally {
      await db.query(
        `ALTER TABLE "finance_schema"."cashbox_history_x" RENAME TO "cashbox_history"`,
      );
    }
  });
});
