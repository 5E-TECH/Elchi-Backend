import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { BranchCashboxSingleBucket1716000000245 } from '../../../migrations/1716000000245-BranchCashboxSingleBucket';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';
import { CashboxCardService } from './cashbox-card/cashbox-card.service';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';

/**
 * 63HO6cBU — migratsiya 245 haqiqiy Postgres'da (`finance_schema` ga qattiq
 * bog'langan — spec o'z vaqtinchalik bazasini yaratadi va o'chiradi):
 *  • har BRANCH kassasi: jami o'zgarmaydi, `balance_card` = 0;
 *  • filial kartalari nofaol, nomli qoldiq 0 (o'chirilmaydi); MAIN / kuryer
 *    tegilmaydi;
 *  • ochiq filial smenasi: ochilishdagi karta surati jamiga; yopiq smena va
 *    MAIN smenasi tegilmaydi;
 *  • ikki marta yurgizilsa ham natija bir xil;
 *  • down() — asl bo'linish tiklanadi (jami o'zgarmaydi).
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('63HO6cBU migratsiya 245 — filial kassasi bitta jami', () => {
  const dbName = `spec_m245_${randomUUID().replace(/-/g, '').slice(0, 10)}_test`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new BranchCashboxSingleBucket1716000000245();

  const run = async (direction: 'up' | 'down') => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await migration[direction](runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        CashboxCard,
        CashboxCardMovement,
        Shift,
      ],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA "finance_schema"');
    await db.synchronize();
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  let ids: Record<string, string>;

  const seed = async () => {
    await db.query(
      `DROP TABLE IF EXISTS "finance_schema"."branch_cashbox_backup_245",
         "finance_schema"."branch_card_backup_245",
         "finance_schema"."branch_shift_backup_245"`,
    );
    await db.query(
      `TRUNCATE TABLE "finance_schema"."cashbox_cards",
         "finance_schema"."cashbox_card_movements",
         "finance_schema"."cashbox_history",
         "finance_schema"."shifts", "finance_schema"."cashboxes"
       RESTART IDENTITY CASCADE`,
    );
    const cashboxes = db.getRepository(Cashbox);
    const make = (
      user_id: string,
      cashbox_type: Cashbox_type,
      cash: number,
      card: number,
    ) =>
      cashboxes.create({
        user_id,
        cashbox_type,
        balance: cash + card,
        balance_cash: cash,
        balance_card: card,
      });
    const [main, b1, b2, b3, courier] = await cashboxes.save([
      make('0', Cashbox_type.MAIN, 200_000, 300_000),
      make('13', Cashbox_type.BRANCH, 100_000, 250_000),
      make('14', Cashbox_type.BRANCH, -40_000, 10_000),
      make('15', Cashbox_type.BRANCH, 70_000, 0),
      make('501', Cashbox_type.FOR_COURIER, 5_000, 0),
    ]);
    const cards = db.getRepository(CashboxCard);
    const card = (cb: Cashbox, name: string, extra: Partial<CashboxCard>) =>
      cards.create({
        cashbox_id: String(cb.id),
        name,
        balance: 0,
        is_default: false,
        is_active: true,
        ...extra,
      });
    const [mainNamed, b1Default, b1Named, b1Archived] = await cards.save([
      card(main, 'HQ Humo', { balance: 120_000 }),
      card(b1, 'Asosiy karta', { is_default: true }),
      card(b1, 'Filial Uzcard', { balance: 90_000 }),
      card(b1, 'Eski', { is_active: false, balance: 0 }),
    ]);
    const shifts = db.getRepository(Shift);
    const shift = (
      cashbox_user_id: string,
      status: ShiftStatus,
      cash: number,
      card: number,
    ) =>
      shifts.create({
        opened_by: cashbox_user_id === '0' ? '1' : `8${cashbox_user_id}`,
        opened_at: new Date(),
        status,
        opening_balance_cash: cash,
        opening_balance_card: card,
        cashbox_user_id,
        ...(status === ShiftStatus.CLOSED ? { closed_at: new Date() } : {}),
      });
    const [openBranch, closedBranch, openMain, openNoBox] = await shifts.save([
      shift('13', ShiftStatus.OPEN, 100_000, 250_000),
      shift('14', ShiftStatus.CLOSED, 1_000, 2_000),
      shift('0', ShiftStatus.OPEN, 200_000, 300_000),
      // N9: kassa qatori yo'q filial (servis `shiftCashboxType` — BRANCH).
      shift('16', ShiftStatus.OPEN, 3_000, 4_000),
    ]);
    ids = {
      main: String(main.id),
      b1: String(b1.id),
      b2: String(b2.id),
      b3: String(b3.id),
      courier: String(courier.id),
      mainNamed: String(mainNamed.id),
      b1Default: String(b1Default.id),
      b1Named: String(b1Named.id),
      b1Archived: String(b1Archived.id),
      openBranch: String(openBranch.id),
      closedBranch: String(closedBranch.id),
      openMain: String(openMain.id),
      openNoBox: String(openNoBox.id),
    };
    // Migratsiyadan OLDINGI karta tarixi (b1): nomli kartaga 90 000, Asosiy
    // kartaga (card_id NULL) 160 000 click kirim.
    const history = db.getRepository(CashboxHistory);
    const past = new Date(Date.now() - 86_400_000);
    await history.save([
      history.create({
        operation_type: Operation_type.INCOME,
        cashbox_id: ids.b1,
        source_type: Source_type.COURIER_PAYMENT,
        amount: 90_000,
        balance_after: 0,
        payment_method: PaymentMethod.CLICK,
        card_id: ids.b1Named,
        createdAt: past,
      } as Partial<CashboxHistory>),
      history.create({
        operation_type: Operation_type.INCOME,
        cashbox_id: ids.b1,
        source_type: Source_type.COURIER_PAYMENT,
        amount: 160_000,
        balance_after: 0,
        payment_method: PaymentMethod.CLICK,
        card_id: null,
        createdAt: past,
      } as Partial<CashboxHistory>),
    ]);
  };

  const boxOf = async (id: string) => {
    const row = await db.getRepository(Cashbox).findOneByOrFail({ id });
    return [
      Number(row.balance),
      Number(row.balance_cash),
      Number(row.balance_card),
    ];
  };
  const cardOf = async (id: string) => {
    const row = await db.getRepository(CashboxCard).findOneByOrFail({ id });
    return [Number(row.balance), row.is_active, row.isDeleted];
  };
  const shiftOf = async (id: string) => {
    const row = await db.getRepository(Shift).findOneByOrFail({ id });
    return [Number(row.opening_balance_cash), Number(row.opening_balance_card)];
  };

  const assertMigrated = async () => {
    // Jami o'zgarmaydi, karta 0.
    expect(await boxOf(ids.b1)).toEqual([350_000, 350_000, 0]);
    expect(await boxOf(ids.b2)).toEqual([-30_000, -30_000, 0]);
    expect(await boxOf(ids.b3)).toEqual([70_000, 70_000, 0]);
    // MAIN va kuryer — tegilmaydi.
    expect(await boxOf(ids.main)).toEqual([500_000, 200_000, 300_000]);
    expect(await boxOf(ids.courier)).toEqual([5_000, 5_000, 0]);
    // Filial kartalari nofaol, o'chirilmagan; MAIN kartasi tegilmaydi.
    expect(await cardOf(ids.b1Default)).toEqual([0, false, false]);
    expect(await cardOf(ids.b1Named)).toEqual([0, false, false]);
    expect(await cardOf(ids.b1Archived)).toEqual([0, false, false]);
    expect(await cardOf(ids.mainNamed)).toEqual([120_000, true, false]);
    // Ochiq filial smenasi — karta surati jamiga; boshqalar tegilmaydi.
    expect(await shiftOf(ids.openBranch)).toEqual([350_000, 0]);
    expect(await shiftOf(ids.closedBranch)).toEqual([1_000, 2_000]);
    expect(await shiftOf(ids.openMain)).toEqual([200_000, 300_000]);
    // N9: kassa qatori bo'lmagan filial smenasi ham (servis qoidasi).
    expect(await shiftOf(ids.openNoBox)).toEqual([7_000, 0]);
    // N1: har kartaga BITTA jurnal qatori (qayta yurganda ham).
    const movements = await db.query(
      `SELECT type, cashbox_id::text AS cashbox_id, from_card_id::text AS from_card,
              amount::float AS amount, comment
         FROM "finance_schema"."cashbox_card_movements" ORDER BY id`,
    );
    expect(movements).toEqual(
      expect.arrayContaining([
        {
          type: 'card_to_cash',
          cashbox_id: ids.b1,
          from_card: ids.b1Default,
          amount: 160_000,
          comment: "Migratsiya 245: karta qoldig'i jamiga",
        },
        expect.objectContaining({
          type: 'card_to_cash',
          cashbox_id: ids.b1,
          from_card: ids.b1Named,
          amount: 90_000,
        }),
      ]),
    );
    // b2 Asosiy kartasi yo'q (nomli ham) — uning karta qismi jurnalsiz.
    expect(movements).toHaveLength(2);
  };

  it('up(): jami o`zgarmaydi, balance_card = 0, filial kartalari nofaol, ochiq smena jamiga', async () => {
    await seed();
    await run('up');
    await assertMigrated();
  });

  it('⭐ N1: eski filial karta ko`chirmasi — ochilish/yopilish to`g`ri (0 → +kirim → jamiga → 0); deploy`dan keyingi yangi filial qatori arxiv Asosiy kartaga yig`ilmaydi', async () => {
    await seed();
    await run('up');
    // Deploy'dan keyin: card_id NULL click qator (masalan T6 / eski FE).
    await db.getRepository(CashboxHistory).save(
      db.getRepository(CashboxHistory).create({
        operation_type: Operation_type.EXPENSE,
        cashbox_id: ids.b1,
        source_type: Source_type.BRANCH_TO_MAIN,
        amount: 5_000,
        balance_after: 0,
        payment_method: PaymentMethod.CLICK,
        card_id: null,
        createdAt: new Date(Date.now() + 60_000),
      } as Partial<CashboxHistory>),
    );
    const cards = new CashboxCardService(db, {} as never);
    for (const [id, amount] of [
      [ids.b1Default, 160_000],
      [ids.b1Named, 90_000],
    ] as const) {
      const res: any = await cards.getLedger({ id });
      const { items, summary } = res.data;
      expect(items.map((r: any) => [r.kind, r.delta, r.balance_after])).toEqual(
        [
          ['card_to_cash', -amount, 0],
          ['income', amount, amount],
        ],
      );
      expect(summary).toMatchObject({
        opening_balance: 0,
        closing_balance: 0,
        total_in: amount,
        total_out: amount,
        current_balance: 0,
      });
    }
  });

  it('idempotent: ikki marta yurgizilsa ham natija bir xil', async () => {
    await seed();
    await run('up');
    await run('up');
    await assertMigrated();
  });

  it('down(): jami o`zgarmagan kassada asl bo`linish tiklanadi (kassa, nomli karta, ochiq smena); zaxira jadvallari o`chadi; qayta down() xatosiz', async () => {
    await seed();
    await run('up');
    await run('down');
    expect(await boxOf(ids.b1)).toEqual([350_000, 100_000, 250_000]);
    expect(await boxOf(ids.b2)).toEqual([-30_000, -40_000, 10_000]);
    expect(await boxOf(ids.b3)).toEqual([70_000, 70_000, 0]);
    expect(await boxOf(ids.main)).toEqual([500_000, 200_000, 300_000]);
    expect(await cardOf(ids.b1Named)).toEqual([90_000, true, false]);
    expect(await cardOf(ids.b1Default)).toEqual([0, true, false]);
    expect(await cardOf(ids.b1Archived)).toEqual([0, false, false]);
    expect(await shiftOf(ids.openBranch)).toEqual([100_000, 250_000]);
    // N1: tiklangan kassaning migratsiya jurnal qatorlari o'chadi.
    const [{ m }] = await db.query(
      `SELECT count(*)::int AS m FROM "finance_schema"."cashbox_card_movements"`,
    );
    expect(m).toBe(0);
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'finance_schema' AND table_name LIKE '%_backup_245'`,
    );
    expect(n).toBe(0);
    await run('down');
  });

  it('⭐ up → filial pul sarfladi → down(): bo`linish TIKLANMAYDI (naqd manfiy / «fantom» karta yo`q) — eski kod karta chiqimini 400 bilan rad etadi', async () => {
    await seed();
    await run('up');
    // up() dan keyin filial 299 999,65 so'm topshirdi (jami o'zgardi).
    await db.query(
      `UPDATE "finance_schema"."cashboxes"
          SET balance_cash = balance_cash - 299999.65, balance = balance - 299999.65
        WHERE id = $1`,
      [ids.b1],
    );
    await run('down');
    // Hammasi naqd, karta 0 — eski kod karta bo'lagidan click chiqimni
    // (nextCard < 0) rad etadi, filial jami manfiyga tushmaydi.
    expect(await boxOf(ids.b1)).toEqual([50_000.35, 50_000.35, 0]);
    expect(await cardOf(ids.b1Named)).toEqual([0, false, false]);
    expect(await cardOf(ids.b1Default)).toEqual([0, false, false]);
    // Shu filialning ochiq smenasi — jami bilan qoladi.
    expect(await shiftOf(ids.openBranch)).toEqual([350_000, 0]);
    // Jami o'zgarmagan boshqa filial — tiklanadi.
    expect(await boxOf(ids.b2)).toEqual([-30_000, -40_000, 10_000]);
  });
});
