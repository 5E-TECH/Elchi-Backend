import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type, PaymentMethod } from '@app/common';
import { CreateCashboxCards1716000000105 } from '../../../migrations/1716000000105-CreateCashboxCards';
import { CashboxCardDetails1716000000161 } from '../../../migrations/1716000000161-CashboxCardDetails';
import { FinanceServiceService } from './finance-service.service';
import { CashboxCardService } from './cashbox-card/cashbox-card.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import {
  CardMovementType,
  CashboxCardMovement,
} from './entities/cashbox-card-movement.entity';

/**
 * 3PE0B03q (UZOQ MUDDAT) — asosiy kassa NOMLI kartalari, HAQIQIY Postgres.
 * Alohida vaqtinchalik BAZA (migratsiya `finance_schema` ni qattiq yozadi):
 * asosiy jadvallar entity sinxronizatsiyasi bilan, karta jadvallari esa
 * FAQAT migratsiya 105 bilan (entity ↔ migratsiya mosligi tekshiriladi).
 *
 * PUL SAQLANISHI (har qadamda): Σ(kartalar) == balance_card,
 * balance == balance_cash + balance_card, kassaning umumiy balansi faqat
 * haqiqiy kirim/chiqimda o'zgaradi.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('3PE0B03q — asosiy kassa nomli kartalari, haqiqiy Postgres', () => {
  const dbName = `spec_cards_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let cards: CashboxCardService;
  let finance: FinanceServiceService;
  const migration = new CreateCashboxCards1716000000105();
  // Zv3MLn0a — karta tafsilotlari (entity ↔ migratsiya mosligi).
  const detailsMigration = new CashboxCardDetails1716000000161();
  const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);

    // 1) Mavjud jadvallar (cashboxes, cashbox_history, shifts) — entity'dan.
    const base = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'finance_schema',
      entities: [Cashbox, CashboxHistory, Shift],
      synchronize: false,
    });
    await base.initialize();
    await base.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
    await base.synchronize();
    // card_id — migratsiya 105 qo'shadi (prod'dagi holat: ustun yo'q).
    await base.query(
      'ALTER TABLE "finance_schema"."cashbox_history" DROP COLUMN "card_id"',
    );
    await base.destroy();

    // 2) Karta jadvallari — FAQAT migratsiya bilan.
    db = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        CashboxCard,
        CashboxCardMovement,
      ],
      synchronize: false,
      extra: { max: 10 },
    });
    await db.initialize();
    const runner = db.createQueryRunner();
    await migration.up(runner);
    await detailsMigration.up(runner);
    await runner.release();

    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    cards = new CashboxCardService(db, activityLog as never);
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      db,
      activityLog as never,
      { send: jest.fn(() => of({ statusCode: 200 })) } as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    );
    jest
      .spyOn(finance as any, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined);
  }, 60_000);

  afterAll(async () => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    } else {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  const cashboxRepo = () => db.getRepository(Cashbox);
  const main = () =>
    cashboxRepo().findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });

  beforeEach(async () => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    await db.query(
      `TRUNCATE TABLE "finance_schema"."cashbox_card_movements",
        "finance_schema"."cashbox_cards", "finance_schema"."cashbox_history",
        "finance_schema"."shifts", "finance_schema"."cashboxes"
        RESTART IDENTITY CASCADE`,
    );
    await cashboxRepo().save([
      cashboxRepo().create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 600_000,
        balance_cash: 500_000,
        balance_card: 100_000,
      }),
      cashboxRepo().create({
        user_id: '201',
        cashbox_type: Cashbox_type.FOR_MARKET,
        balance: 1_000_000,
        balance_cash: 1_000_000,
        balance_card: 0,
      }),
    ]);
  });

  /** Invariant: Σ kartalar == balance_card; balance == naqd + karta. */
  const expectInvariant = async () => {
    const list: any = await cards.listCards({ include_inactive: true });
    const cashbox = await main();
    const sum = list.data.cards.reduce(
      (s: number, c: { balance: number }) => s + c.balance,
      0,
    );
    expect(sum).toBeCloseTo(cashbox.balance_card, 2);
    expect(list.data.total_card).toBeCloseTo(cashbox.balance_card, 2);
    expect(cashbox.balance).toBeCloseTo(
      cashbox.balance_cash + cashbox.balance_card,
      2,
    );
    return { list: list.data, cashbox };
  };

  const createHumo = async (): Promise<string> => {
    const res: any = await cards.createCard({
      name: 'Humo 8600',
      created_by: '1',
    });
    return String(res.data.card.id);
  };
  const defaultId = async (): Promise<string> => {
    const list: any = await cards.listCards();
    return String(list.data.cards.find((c: any) => c.is_default).id);
  };

  it('migratsiya 105: jadvallar, noyob indekslar, cashbox_history.card_id; down() → up()', async () => {
    const cols = async (table: string) =>
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'finance_schema' AND table_name = $1`,
          [table],
        )
      ).map((r: { column_name: string }) => r.column_name);
    expect(await cols('cashbox_cards')).toEqual(
      expect.arrayContaining(['cashbox_id', 'name', 'balance', 'is_default']),
    );
    expect(await cols('cashbox_card_movements')).toEqual(
      expect.arrayContaining([
        'type',
        'from_card_id',
        'to_card_id',
        'dedup_epoch',
      ]),
    );
    expect(await cols('cashbox_history')).toContain('card_id');
    const indexes = (
      await db.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'finance_schema'`,
      )
    ).map((r: { indexname: string }) => r.indexname);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'UQ_CASHBOX_CARD_DEFAULT',
        'UQ_CASHBOX_CARD_NAME',
        'UQ_CARD_MOVEMENT_DEDUP',
      ]),
    );

    const runner = db.createQueryRunner();
    try {
      await detailsMigration.down(runner);
      await migration.down(runner);
      expect(await cols('cashbox_cards')).toEqual([]);
      expect(await cols('cashbox_history')).not.toContain('card_id');
    } finally {
      await migration.up(runner);
      await detailsMigration.up(runner);
      await runner.release();
    }
  });

  it('⭐ ro`yxat: Asosiy karta avtomatik, balansi = balance_card (seed yo`q), in_sync; ikkinchi chaqiruv yangi qator yaratmaydi', async () => {
    const { list } = await expectInvariant();
    expect(list.cards).toHaveLength(1);
    expect(list.cards[0]).toMatchObject({
      name: 'Asosiy karta',
      is_default: true,
      balance: 100_000,
    });
    expect(list).toMatchObject({
      balance_card: 100_000,
      named_total: 0,
      in_sync: true,
    });
    await cards.listCards();
    expect(
      await db.getRepository(CashboxCard).countBy({ is_default: true }),
    ).toBe(1);
    // Saqlangan Asosiy karta balansi doim 0 (hosila).
    const stored = await db
      .getRepository(CashboxCard)
      .findOneByOrFail({ is_default: true });
    expect(Number(stored.balance)).toBe(0);
  });

  it('yaratish / nom: takroriy nom (harf farqsiz) 409, Asosiy kartani o`zgartirish va arxivlash 400', async () => {
    const humo = await createHumo();
    await expect(
      cards.createCard({ name: '  humo   8600 ' }),
    ).rejects.toMatchObject({ error: { statusCode: 409 } });
    const def = await defaultId();
    await expect(
      cards.renameCard({ id: def, name: 'X' }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await expect(
      cards.setCardActive({ id: def, is_active: false }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    const renamed: any = await cards.renameCard({
      id: humo,
      name: 'Humo 9860',
    });
    expect(renamed.data.card.name).toBe('Humo 9860');
  });

  it('⭐ o`tkazma: Asosiy → Humo 60 000; balance_card o`zgarmaydi; takroriy kalit ikkinchi harakat yozmaydi; yetmasa 400', async () => {
    const humo = await createHumo();
    const def = await defaultId();

    const first: any = await cards.transfer({
      from_card_id: def,
      to_card_id: humo,
      amount: 60_000,
      comment: 'Humo ga',
      created_by: '1',
      dedup_epoch: 'key-1',
    });
    expect(first.statusCode).toBe(201);
    const replay: any = await cards.transfer({
      from_card_id: def,
      to_card_id: humo,
      amount: 60_000,
      comment: 'Humo ga',
      dedup_epoch: 'key-1',
    });
    expect(replay.data.idempotent).toBe(true);
    expect(await db.getRepository(CashboxCardMovement).count()).toBe(1);

    const { list, cashbox } = await expectInvariant();
    expect(cashbox).toMatchObject({ balance_card: 100_000, balance: 600_000 });
    expect(list.cards.map((c: any) => [c.name, c.balance])).toEqual([
      ['Asosiy karta', 40_000],
      ['Humo 8600', 60_000],
    ]);
    expect(first.data.movement).toMatchObject({
      type: CardMovementType.CARD_TO_CARD,
      balance_after_from: 40_000,
      balance_after_to: 60_000,
    });

    await expect(
      cards.transfer({
        from_card_id: humo,
        to_card_id: def,
        amount: 70_000,
        comment: 'ortiq',
      }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/yetarli/) },
    });
    await expectInvariant();
  });

  it('⭐ konvertatsiya: Humo → naqd 10 000 va naqd → Asosiy 5 000; umumiy balans o`zgarmaydi, tarixga yozilmaydi', async () => {
    const humo = await createHumo();
    const def = await defaultId();
    await cards.transfer({
      from_card_id: def,
      to_card_id: humo,
      amount: 60_000,
      comment: 'x',
    });

    await cards.convert({
      type: CardMovementType.CARD_TO_CASH,
      card_id: humo,
      amount: 10_000,
      comment: 'bankomat',
    });
    await cards.convert({
      type: CardMovementType.CASH_TO_CARD,
      card_id: def,
      amount: 5_000,
      comment: 'kartaga',
    });

    const { list, cashbox } = await expectInvariant();
    expect(cashbox).toMatchObject({
      balance: 600_000,
      balance_cash: 505_000,
      balance_card: 95_000,
    });
    expect(list.cards.map((c: any) => [c.name, c.balance])).toEqual([
      ['Asosiy karta', 45_000],
      ['Humo 8600', 50_000],
    ]);
    expect(await db.getRepository(CashboxHistory).count()).toBe(0);

    await expect(
      cards.convert({
        type: CardMovementType.CASH_TO_CARD,
        card_id: humo,
        amount: 1_000_000,
        comment: 'ortiq',
      }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
  });

  it('⭐ card_id bilan CLICK chiqim/kirim (spend/fill, marketga to`lov): nomli karta balansi o`zgaradi, tarixda card_id; yetmasa 400 va hech narsa o`zgarmaydi', async () => {
    const humo = await createHumo();
    const def = await defaultId();
    await cards.transfer({
      from_card_id: def,
      to_card_id: humo,
      amount: 60_000,
      comment: 'x',
    });

    const spent: any = await finance.spendMoney({
      user_id: '1',
      amount: 20_000,
      type: PaymentMethod.CLICK,
      card_id: humo,
    });
    expect(spent.data.history.card_id).toBe(humo);
    await finance.fillTheCashbox({
      user_id: '1',
      amount: 5_000,
      type: PaymentMethod.CLICK,
      card_id: humo,
    });
    await finance.paymentsToMarket({
      market_id: '201',
      amount: 15_000,
      payment_method: PaymentMethod.CLICK,
      card_id: humo,
    });

    let state = await expectInvariant();
    expect(state.list.cards.map((c: any) => [c.name, c.balance])).toEqual([
      ['Asosiy karta', 40_000],
      ['Humo 8600', 30_000],
    ]);
    expect(state.cashbox.balance_card).toBe(70_000);

    // Humo da 30 000 — 50 000 chiqim 400; kassa ham, karta ham o'zgarmaydi.
    await expect(
      finance.spendMoney({
        user_id: '1',
        amount: 50_000,
        type: PaymentMethod.CLICK,
        card_id: humo,
      }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/Humo/) },
    });
    state = await expectInvariant();
    expect(state.cashbox.balance_card).toBe(70_000);

    // Naqd to'lovda card_id — 400.
    await expect(
      finance.spendMoney({ user_id: '1', amount: 1_000, card_id: humo }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });

    // Kartasiz CLICK chiqim — Asosiy karta (avvalgi xatti-harakat).
    const plain: any = await finance.spendMoney({
      user_id: '1',
      amount: 10_000,
      type: PaymentMethod.CLICK,
    });
    expect(plain.data.history.card_id).toBeNull();
    state = await expectInvariant();
    expect(state.list.cards.map((c: any) => [c.name, c.balance])).toEqual([
      ['Asosiy karta', 30_000],
      ['Humo 8600', 30_000],
    ]);
  });

  it('parallel ikki chiqim bitta nomli kartadan — biri o`tadi, ikkinchisi 400; karta manfiyga tushmaydi', async () => {
    const humo = await createHumo();
    await cards.transfer({
      from_card_id: await defaultId(),
      to_card_id: humo,
      amount: 30_000,
      comment: 'x',
    });

    const results = await Promise.allSettled([
      finance.spendMoney({
        user_id: '1',
        amount: 20_000,
        type: PaymentMethod.CLICK,
        card_id: humo,
      }),
      finance.spendMoney({
        user_id: '1',
        amount: 20_000,
        type: PaymentMethod.CLICK,
        card_id: humo,
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const card = await db
      .getRepository(CashboxCard)
      .findOneByOrFail({ id: humo });
    expect(Number(card.balance)).toBe(10_000);
    await expectInvariant();
  });

  it('arxivlash: balansli karta 400; balansi 0 bo`lgach arxivlanadi va operatsiyada ishlatib bo`lmaydi', async () => {
    const humo = await createHumo();
    const def = await defaultId();
    await cards.transfer({
      from_card_id: def,
      to_card_id: humo,
      amount: 1_000,
      comment: 'x',
    });
    await expect(
      cards.setCardActive({ id: humo, is_active: false }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await cards.transfer({
      from_card_id: humo,
      to_card_id: def,
      amount: 1_000,
      comment: 'qaytdi',
    });
    await cards.setCardActive({ id: humo, is_active: false });
    await expect(
      finance.fillTheCashbox({
        user_id: '1',
        amount: 1_000,
        type: PaymentMethod.CLICK,
        card_id: humo,
      }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/arxiv/) },
    });
    const active: any = await cards.listCards();
    expect(active.data.cards).toHaveLength(1);
  });

  it('karta ledgeri: kirim/chiqim + ichki harakatlar, har qatordan keyingi balans, yakuni = joriy balans', async () => {
    const humo = await createHumo();
    const def = await defaultId();
    await cards.transfer({
      from_card_id: def,
      to_card_id: humo,
      amount: 60_000,
      comment: 'x',
    });
    await finance.spendMoney({
      user_id: '1',
      amount: 20_000,
      type: PaymentMethod.CLICK,
      card_id: humo,
    });
    await cards.convert({
      type: CardMovementType.CARD_TO_CASH,
      card_id: humo,
      amount: 5_000,
      comment: 'bankomat',
    });

    const res: any = await cards.getLedger({ id: humo });

    expect(
      res.data.items.map((r: any) => [r.kind, r.delta, r.balance_after]),
    ).toEqual([
      ['card_to_cash', -5_000, 35_000],
      ['expense', -20_000, 40_000],
      ['transfer_in', 60_000, 60_000],
    ]);
    expect(res.data.summary).toMatchObject({
      opening_balance: 0,
      closing_balance: 35_000,
      total_in: 60_000,
      total_out: 25_000,
      current_balance: 35_000,
    });

    const defLedger: any = await cards.getLedger({ id: def });
    expect(defLedger.data.summary.current_balance).toBe(40_000);
    expect(defLedger.data.items[0]).toMatchObject({
      kind: 'transfer_out',
      delta: -60_000,
      balance_after: 40_000,
    });
  });

  it('smena darvozasi yoqilgan: o`tkazma smenasiz 400; konvertatsiya smena kutilgan qoldig`iga qo`shiladi (soxta kamomad yo`q)', async () => {
    const humo = await createHumo();
    const def = await defaultId();
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const warn = jest
      .spyOn((cards as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      cards.transfer({
        from_card_id: def,
        to_card_id: humo,
        amount: 1_000,
        comment: 'x',
      }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/^Smena/) },
    });
    // 32Sw3DfC — kuzatuv qatori (rad etilgan amallar soni).
    expect(warn).toHaveBeenCalledWith(
      'shift_gate_blocked code=SHIFT_REQUIRED cashbox_type=main cashbox_user_id=0 scope=main',
    );

    const opened: any = await finance.openShift({ opened_by: '1' });
    expect(opened.data).toMatchObject({
      opening_balance_cash: 500_000,
      opening_balance_card: 100_000,
    });
    await cards.convert({
      type: CardMovementType.CARD_TO_CASH,
      card_id: def,
      amount: 10_000,
      comment: 'bankomat',
    });

    const closed: any = await finance.closeShift({
      closed_by: '1',
      closing_balance_cash: 510_000,
      closing_balance_card: 90_000,
    });

    expect(closed.data).toMatchObject({
      status: ShiftStatus.CLOSED,
      expected_balance_cash: 510_000,
      expected_balance_card: 90_000,
      discrepancy_cash: 0,
      discrepancy_card: 0,
    });
  });
});
