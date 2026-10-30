import { DataSource } from 'typeorm';
import { PaymentCorrections1716000000186 } from '../../../../migrations/1716000000186-PaymentCorrections';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';

/**
 * T6-BE-1 — migratsiya 186 haqiqiy Postgres'da (FINANCE_T6_PG_TEST_URI
 * bo'lmasa skip). Migratsiya `finance_schema` ga qattiq bog'langan, shu bois
 * FAQAT nomida `test` bo'lgan alohida bazada ishlaydi (sxemani qayta quradi).
 *
 *  • ustunlar / indekslar / jadval / enum qiymati yaratiladi, qayta yurgizish
 *    xatosiz;
 *  • backfill: aniq juftliklar bitta `transfer_id` ga, click_to_market —
 *    to'rt oyoq bitta guruh, noaniq (ikki nomzod) va 5 s dan uzoq — NULL;
 *    365 kundan eski — tegilmaydi;
 *  • down(): tozalanadi.
 */
const pgUri = process.env.FINANCE_T6_PG_TEST_URI;
const describePg =
  pgUri && /test/i.test(new URL(pgUri).pathname) ? describe : describe.skip;

describePg('T6 migratsiya 186 — haqiqiy Postgres', () => {
  let db: DataSource;
  const migration = new PaymentCorrections1716000000186();

  const run = async (fn: 'up' | 'down') => {
    const qr = db.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await migration[fn](qr);
      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  };

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query('DROP SCHEMA IF EXISTS "finance_schema" CASCADE');
    await admin.query('CREATE SCHEMA "finance_schema"');
    await admin.destroy();
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema: 'finance_schema',
      entities: [Cashbox, CashboxHistory],
      synchronize: true,
    });
    await db.initialize();
    // Migratsiyadan OLDINGI holat: yangi ustunlar / indekslar va enum qiymati yo'q.
    await db.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_TRANSFER"`,
    );
    await db.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_CASHBOX_HISTORY_REVERSES"`,
    );
    await db.query(`ALTER TABLE "finance_schema"."cashbox_history"
      DROP COLUMN "transfer_id", DROP COLUMN "reverses_history_id"`);
    await db.query(`
      ALTER TYPE "finance_schema"."cashbox_history_source_type_enum"
        RENAME TO "cashbox_history_source_type_enum_old"`);
    await db.query(`
      CREATE TYPE "finance_schema"."cashbox_history_source_type_enum" AS ENUM
        ('courier_payment','branch_to_main','market_payment','manual_expense',
         'manual_income','correction','salary','sell','cancel','extra_cost','bills')`);
    await db.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        ALTER COLUMN "source_type" TYPE "finance_schema"."cashbox_history_source_type_enum"
        USING "source_type"::text::"finance_schema"."cashbox_history_source_type_enum"`);
    await db.query(
      `DROP TYPE "finance_schema"."cashbox_history_source_type_enum_old"`,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query('DROP SCHEMA IF EXISTS "finance_schema" CASCADE');
      await db.destroy();
    }
  });

  const box = async (user_id: string, cashbox_type: string) => {
    const [row] = await db.query<Array<{ id: string }>>(
      `INSERT INTO "finance_schema"."cashboxes"
         ("user_id","cashbox_type","balance","balance_cash","balance_card")
       VALUES ($1,$2,0,0,0) RETURNING "id"`,
      [user_id, cashbox_type],
    );
    return String(row.id);
  };

  const leg = async (input: {
    cashbox: string;
    op: 'income' | 'expense';
    source: string;
    amount: number;
    by: string;
    method: string;
    user: string;
    at: string;
  }) => {
    const [row] = await db.query<Array<{ id: string }>>(
      `INSERT INTO "finance_schema"."cashbox_history"
         ("operation_type","cashbox_id","source_type","amount","balance_after",
          "payment_method","created_by","source_user_id","createdAt")
       VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8) RETURNING "id"`,
      [
        input.op,
        input.cashbox,
        input.source,
        input.amount,
        input.method,
        input.by,
        input.user,
        input.at,
      ],
    );
    return String(row.id);
  };

  const tid = async (id: string) => {
    const [row] = await db.query<Array<{ transfer_id: string | null }>>(
      `SELECT "transfer_id" FROM "finance_schema"."cashbox_history" WHERE "id" = $1`,
      [id],
    );
    return row.transfer_id;
  };

  it('⭐ ustunlar, jadval, enum; backfill aniq/noaniq; qayta yurgizish; down', async () => {
    const main = await box('0', 'main');
    const branch = await box('15', 'branch');
    const courier = await box('301', 'couriers');
    const courier2 = await box('302', 'couriers');
    const market = await box('501', 'markets');
    const ago = (seconds: number) =>
      new Date(Date.now() - seconds * 1000).toISOString();

    // 1) Oddiy HQ naqd to'lov — juftlik aniq.
    const a1 = await leg({
      cashbox: courier,
      op: 'expense',
      source: 'courier_payment',
      amount: 500_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(1000),
    });
    const a2 = await leg({
      cashbox: main,
      op: 'income',
      source: 'courier_payment',
      amount: 500_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(999),
    });
    // 2) Filial kassasiga — aniq.
    const b1 = await leg({
      cashbox: courier2,
      op: 'expense',
      source: 'courier_payment',
      amount: 70_000,
      by: '9',
      method: 'click',
      user: '302',
      at: ago(900),
    });
    const b2 = await leg({
      cashbox: branch,
      op: 'income',
      source: 'courier_payment',
      amount: 70_000,
      by: '9',
      method: 'click',
      user: '302',
      at: ago(900),
    });
    // 3) click_to_market — to'rt oyoq.
    const c1 = await leg({
      cashbox: courier,
      op: 'expense',
      source: 'courier_payment',
      amount: 120_000,
      by: '1',
      method: 'click_to_market',
      user: '301',
      at: ago(800),
    });
    const c2 = await leg({
      cashbox: main,
      op: 'income',
      source: 'courier_payment',
      amount: 120_000,
      by: '1',
      method: 'click_to_market',
      user: '301',
      at: ago(800),
    });
    const c3 = await leg({
      cashbox: main,
      op: 'expense',
      source: 'market_payment',
      amount: 120_000,
      by: '1',
      method: 'click_to_market',
      user: '501',
      at: ago(800),
    });
    const c4 = await leg({
      cashbox: market,
      op: 'expense',
      source: 'market_payment',
      amount: 120_000,
      by: '1',
      method: 'click_to_market',
      user: '501',
      at: ago(799),
    });
    // 4) Marketga to'lov — aniq.
    const d1 = await leg({
      cashbox: main,
      op: 'expense',
      source: 'market_payment',
      amount: 300_000,
      by: '1',
      method: 'cash',
      user: '501',
      at: ago(700),
    });
    const d2 = await leg({
      cashbox: market,
      op: 'expense',
      source: 'market_payment',
      amount: 300_000,
      by: '1',
      method: 'cash',
      user: '501',
      at: ago(700),
    });
    // 5) NOANIQ: bir xil summadagi ikki qabul qiluvchi oyoq — hech biri bog'lanmaydi.
    const e1 = await leg({
      cashbox: courier,
      op: 'expense',
      source: 'courier_payment',
      amount: 40_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(600),
    });
    const e2 = await leg({
      cashbox: main,
      op: 'income',
      source: 'courier_payment',
      amount: 40_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(600),
    });
    const e3 = await leg({
      cashbox: main,
      op: 'income',
      source: 'courier_payment',
      amount: 40_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(599),
    });
    // 6) 5 s dan uzoq — bog'lanmaydi.
    const f1 = await leg({
      cashbox: courier,
      op: 'expense',
      source: 'courier_payment',
      amount: 11_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(500),
    });
    const f2 = await leg({
      cashbox: main,
      op: 'income',
      source: 'courier_payment',
      amount: 11_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(490),
    });
    // 7) 365 kundan eski — tegilmaydi.
    const old = 400 * 86_400;
    const g1 = await leg({
      cashbox: courier,
      op: 'expense',
      source: 'courier_payment',
      amount: 9_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(old),
    });
    const g2 = await leg({
      cashbox: main,
      op: 'income',
      source: 'courier_payment',
      amount: 9_000,
      by: '1',
      method: 'cash',
      user: '301',
      at: ago(old),
    });

    await run('up');

    const [t1, t2] = [await tid(a1), await tid(a2)];
    expect(t1).toMatch(/^[0-9a-f-]{36}$/);
    expect(t2).toBe(t1);
    expect(await tid(b1)).toBe(await tid(b2));
    expect(await tid(b1)).not.toBeNull();
    const click = await tid(c1);
    expect(click).not.toBeNull();
    for (const id of [c2, c3, c4]) expect(await tid(id)).toBe(click);
    expect(await tid(d1)).toBe(await tid(d2));
    expect(await tid(d1)).not.toBeNull();
    expect(new Set([t1, await tid(b1), click, await tid(d1)]).size).toBe(4);
    for (const id of [e1, e2, e3, f1, f2, g1, g2]) {
      expect(await tid(id)).toBeNull();
    }

    const enumRows = await db.query<unknown[]>(`
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'cashbox_history_source_type_enum'
         AND e.enumlabel = 'payment_reversal'`);
    expect(enumRows).toHaveLength(1);
    const table = await db.query<Array<{ t: string | null }>>(
      `SELECT to_regclass('finance_schema.payment_corrections') AS t`,
    );
    expect(table[0].t).not.toBeNull();

    // Qayta yurgizish — xatosiz, bog'langanlar o'zgarmaydi.
    await run('up');
    expect(await tid(a1)).toBe(t1);

    // reverses_history_id UNIQUE (faol qatorlar).
    await db.query(
      `UPDATE "finance_schema"."cashbox_history" SET "reverses_history_id" = $1 WHERE "id" = $2`,
      [a1, e1],
    );
    await expect(
      db.query(
        `UPDATE "finance_schema"."cashbox_history" SET "reverses_history_id" = $1 WHERE "id" = $2`,
        [a1, e2],
      ),
    ).rejects.toThrow(/UQ_CASHBOX_HISTORY_REVERSES/);

    await run('down');
    const cols = await db.query<unknown[]>(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'finance_schema' AND table_name = 'cashbox_history'
         AND column_name IN ('transfer_id','reverses_history_id')`);
    expect(cols).toHaveLength(0);
  }, 60_000);
});
