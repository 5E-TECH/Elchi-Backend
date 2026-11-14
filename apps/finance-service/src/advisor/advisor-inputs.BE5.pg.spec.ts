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
    it('R7 karta: faqat tasdiqlangan mismatch; farq = o‘qilgan − kiritilgan; kursor ai_checked_at', async () => {
      await db.query(
        `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('main', 0)`,
      );
      const [{ id: card }] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashbox_cards" ("cashbox_id", "name") VALUES (1, 'Humo virtual') RETURNING "id"::text AS id`,
      );
      const newShift = async () => {
        const [row] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."shifts" ("cashbox_user_id", "opened_at", "closed_at", "status")
           VALUES (NULL, '2026-10-21T03:00:00Z', '2026-10-21T15:00:00Z', 'closed') RETURNING "id"::text AS id`,
        );
        return row.id;
      };
      let shiftId = '';
      const check = async (status: string, confirmed: boolean, at: string) => {
        shiftId = await newShift();
        const [row] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."shift_account_checks"
             ("shift_id", "cashbox_card_id", "entered_balance", "ai_read_balance", "ai_status", "ai_checked_at", "confirmed_at", "ai_confidence")
           VALUES ($1, $2, 1540000, 1522000, $3, $4, $5, 0.9) RETURNING "id"::text AS id`,
          [shiftId, card, status, at, confirmed ? at : null],
        );
        return row.id;
      };
      const ok = await check('mismatch', true, '2026-10-22T08:30:00Z');
      const okShift = shiftId;
      await check('mismatch', false, '2026-10-22T08:31:00Z'); // qoralama
      await check('match', true, '2026-10-22T08:32:00Z');
      await check('mismatch', true, '2026-10-20T08:30:00Z'); // kursordan oldin
      const out = await svc.ruleInputs({
        rules: ['R7'],
        now: NOW.toISOString(),
        thresholds: {},
        since: { R7: '2026-10-22T08:00:00Z' },
      });
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0]).toMatchObject({
        dedup_key: `R7:card_check:${ok}`,
        fact_keys: [
          {
            fact_key: `R7:card_check:${ok}`,
            fact_at: '2026-10-21T15:00:00.000Z',
          },
        ],
        headline_amount: -18000,
        facts: {
          source: 'card_balance',
          mismatch: ['amount'],
          entered_amount: 1540000,
          read_amount: 1522000,
          difference: -18000,
          shift: { id: okShift, date: '2026-10-21' },
          card: { id: card, name: 'Humo virtual' },
          cashbox: { type: 'main', name: 'Asosiy kassa' },
        },
        evidence: { kind: 'card_balance_check', ai_confidence: 0.9 },
      });
      expect(out.cursors.R7).toBe('2026-10-22T08:30:00.000Z');
    });

    it('R7 chek: bog‘langan mismatch yoki card_mismatch; qoralama va o‘chirilgan — yo‘q; date_at', async () => {
      const [{ id: cb }] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('branch', 9) RETURNING "id"::text AS id`,
      );
      const [{ id: hist }] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "finance_schema"."cashbox_history"
           ("operation_type", "cashbox_id", "source_type", "amount", "balance_after", "expense_category_name", "created_by", "createdAt")
         VALUES ('expense', $1, 'manual_expense', 350000, 0, 'Yoqilg‘i', 301, '2026-10-22T06:05:00Z') RETURNING "id"::text AS id`,
        [cb],
      );
      const receipt = async (
        state: string,
        status: string,
        flags: string[] | null,
        deleted = false,
        h: string | null = hist,
      ) => {
        const [row] = await db.query<Array<{ id: string }>>(
          `INSERT INTO "finance_schema"."cashbox_receipts"
             ("kind", "state", "history_id", "file_key", "file_sha256", "mime", "size_bytes", "uploaded_by",
              "ai_status", "ai_flags", "entered_amount", "ai_amount", "ai_difference", "ai_date",
              "ai_recipient", "ai_recipient_last4", "ai_payer_last4", "ai_checked_at", "is_deleted")
           VALUES ('manual_expense', $1, $2, 'k', repeat('a', 64), 'image/jpeg', 1, 301, $3, $4::jsonb,
                   350000, 332000, -18000, '22.10.2026 11:05', 'ALIYEV A.', '8840', '3307', '2026-10-22T08:40:00Z', $5)
           RETURNING "id"::text AS id`,
          [state, h, status, flags ? JSON.stringify(flags) : null, deleted],
        );
        return row.id;
      };
      const a = await receipt('linked', 'mismatch', ['card_mismatch']);
      await receipt('draft', 'mismatch', null, false, null);
      await receipt('linked', 'mismatch', null, true, null);
      await receipt('linked', 'match', null, false, null);
      const b = await receipt(
        'linked',
        'match',
        ['card_mismatch'],
        false,
        null,
      );
      const out = await svc.ruleInputs({
        rules: ['R7'],
        now: NOW.toISOString(),
        thresholds: {},
        since: { R7: '2026-10-22T08:00:00Z' },
      });
      expect(out.candidates.map((c) => c.dedup_key)).toEqual([
        `R7:receipt:${a}`,
        `R7:receipt:${b}`,
      ]);
      expect(out.candidates[0]).toMatchObject({
        branch: { id: '9', name: 'Filial 9' },
        fact_keys: [{ fact_at: '2026-10-22T06:05:00.000Z' }],
        facts: {
          source: 'receipt',
          mismatch: ['amount', 'card'],
          difference: -18000,
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
            recipient_last4: '8840',
            payer_last4: '3307',
          },
          week_summary: { from: '2026-10-19', to: '2026-10-25' },
        },
      });
      expect(out.candidates[1].facts).toMatchObject({
        mismatch: ['card'],
        operation: null,
      });
    });

    it('R8: qo‘lda + T6 sanaladi, buyurtma qaytarilishi va payment_reversal yo‘q; ≥ 2× bazaviy', async () => {
      await db.query(
        `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id") VALUES ('main', 0), ('couriers', 5)`,
      );
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
      // Baza (30 kun): 2 ta qo'lda tuzatish → haftalik o'rtacha 0,47.
      await corr('2026-09-20T05:00:00Z', null);
      await corr('2026-10-01T05:00:00Z', null);
      // Hafta 12–18.10: 2 qo'lda + 1 reverse + 1 edit = 4; buyurtma (2 oyoq, 1 buyurtma) va reversal sanalmaydi.
      await corr('2026-10-13T05:00:00Z', null);
      await corr('2026-10-14T05:00:00Z', null);
      await corr('2026-10-14T06:00:00Z', 500);
      await corr('2026-10-14T06:00:01Z', 500, 'correction', 2);
      await corr('2026-10-15T06:00:00Z', null, 'payment_reversal');
      await t6('reverse', '2026-10-15T05:00:00Z');
      await t6('edit', '2026-10-16T05:00:00Z');
      const out = await svc.ruleInputs({
        rules: ['R8'],
        now: NOW.toISOString(),
        thresholds: { R8: { ratio: 2 } },
        since: {},
        periods: { weeks: ['2026-10-12'] },
      });
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0]).toMatchObject({
        dedup_key: 'R8:week:2026-10-12',
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
          baseline: { window_days: 30, total: 2 },
        },
      });
      expect(
        (out.candidates[0].evidence.days as Array<{ count: number }>).map(
          (d) => d.count,
        ),
      ).toEqual([0, 1, 1, 1, 1, 0, 0]);

      // Yuqori chegara (10×) — jim; tugamagan hafta — tekshirilmaydi.
      const quiet = await svc.ruleInputs({
        rules: ['R8'],
        now: NOW.toISOString(),
        thresholds: { R8: { ratio: 10 } },
        since: {},
        periods: { weeks: ['2026-10-12', '2026-10-19'] },
      });
      expect(quiet.candidates).toEqual([]);
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
