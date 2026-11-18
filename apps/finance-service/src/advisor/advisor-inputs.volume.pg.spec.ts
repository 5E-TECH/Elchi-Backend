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
 * #702 review B1 — R2/R4/R5 epizod so'rovi hajmda: 100 kuryer × 365 kun ×
 * 7 qator (~255k) bitta `ruleInputs(R2,R4,R5)` da. Ilgari kun boshidagi
 * qoldiq har (kassa, kun) uchun alohida so'rov edi (shu hajmda ~2.7 s,
 * 766k da ~20 s); endi 90 kunlik oynada bitta oyna o'tishi, JIT'siz
 * (0.6 s / 1.9 s). Chegara keng (CI sekinroq) — maqsad tartib farqini ushlash.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('AdvisorInputsService — R2/R4/R5 hajm (#702 B1)', () => {
  const dbName = `spec_advvol_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let svc: AdvisorInputsService;

  beforeAll(async () => {
    const url = new URL(pgUri!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('FINANCE_PG_TEST_URI faqat lokal bo‘lishi kerak');
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
    const ok = { send: jest.fn(() => of({ data: [] })) };
    svc = new AdvisorInputsService(
      db,
      new FinanceDailyService(db),
      ok as never,
      ok as never,
    );
    await db.query(
      `INSERT INTO "finance_schema"."cashboxes" ("cashbox_type", "user_id", "balance")
       SELECT 'couriers', 1000 + g, 3000000 FROM generate_series(1, 100) g`,
    );
    // Har kuni 6 ta tushum (sell) va 1 ta topshirish (courier_payment, ~50%).
    await db.query(
      `INSERT INTO "finance_schema"."cashbox_history"
         ("operation_type", "cashbox_id", "source_type", "amount", "balance_after", "createdAt")
       SELECT CASE WHEN k = 7 THEN 'expense' ELSE 'income' END::finance_schema.cashbox_history_operation_type_enum,
              c."id",
              CASE WHEN k = 7 THEN 'courier_payment' ELSE 'sell' END::finance_schema.cashbox_history_source_type_enum,
              CASE WHEN k = 7 THEN 600000 ELSE 200000 END,
              1000000 + k * 100000,
              TIMESTAMPTZ '2025-10-22 04:00:00+00' + (d || ' days')::interval
                + ((k * 60 + (c."id" % 50)) || ' minutes')::interval
         FROM "finance_schema"."cashboxes" c,
              generate_series(0, 364) d, generate_series(1, 7) k`,
    );
    await db.query('ANALYZE');
  }, 180_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  it('255k qatorda R2/R4/R5 bitta chaqiruv < 2.5 s, xatosiz', async () => {
    const t0 = Date.now();
    const out = await svc.ruleInputs({
      rules: ['R2', 'R4', 'R5'],
      now: '2026-10-22T09:00:00.000Z',
      thresholds: {
        R2: {
          balance_uzs: 2000000,
          growth_days: 3,
          no_handover_days: 3,
          min_handover_pct: 80,
        },
        R4: { days_without_payout: 7 },
        R5: {
          balance_uzs: 5000000,
          days_without_transfer: 3,
          min_transfer_pct: 80,
        },
      },
      since: {},
    });
    const took = Date.now() - t0;
    expect(out.errors).toBeUndefined();
    // Topshirishlar ~50% (< 80%) — hech bir kun hisoblanmaydi, kuryerlar stale.
    expect(out.candidates.filter((c) => c.rule_key === 'R2')).toHaveLength(100);
    // Lokal o'lchov: 0.6 s (oldingi variant 2.7 s; 766k da 1.9 s vs 20 s).
    expect(took).toBeLessThan(2500);
  }, 60_000);
});
