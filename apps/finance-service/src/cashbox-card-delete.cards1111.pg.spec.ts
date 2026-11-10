import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Cashbox_type } from '@app/common';
import { CreateCashboxCards1716000000105 } from '../../../migrations/1716000000105-CreateCashboxCards';
import { CashboxCardDetails1716000000161 } from '../../../migrations/1716000000161-CashboxCardDetails';
import { CashboxCardService } from './cashbox-card/cashbox-card.service';
import { ShiftAccountCheckService } from './shift-account-check/shift-account-check.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { ShiftAccountCheck } from './entities/shift-account-check.entity';
import { FinanceSetting } from './entities/finance-setting.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import {
  CardMovementType,
  CashboxCardMovement,
} from './entities/cashbox-card-movement.entity';

/**
 * cards1111 (Dilshod, 2026-11-11: «kartani balansini 0 qilib shu kartani
 * o'chirish») — `CashboxCardService.deleteCard`, HAQIQIY Postgres.
 * Alohida vaqtinchalik BAZA; karta jadvallari FAQAT migratsiya 105 + 161.
 *
 * PUL SAQLANISHI (har qadamda): Σ(kartalar) == balance_card (Asosiy karta —
 * hosila), balance == naqd + karta; o'chirilgan karta qoldig'i izsiz Asosiy
 * kartaga "oqib" o'tmaydi — avval harakat bilan ko'chadi.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '13';

describePg('cards1111 — kassa kartasini o`chirish, haqiqiy Postgres', () => {
  const dbName = `spec_cdel_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let cards: CashboxCardService;
  let checks: ShiftAccountCheckService;
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const realtime = {
    cashboxCardChanged: jest.fn().mockResolvedValue(undefined),
  };
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

    // 1) Mavjud jadvallar — entity'dan (karta jadvallari emas).
    const base = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        ShiftAccountCheck,
        FinanceSetting,
      ],
      synchronize: false,
    });
    await base.initialize();
    await base.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
    await base.synchronize();
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
        ShiftAccountCheck,
        FinanceSetting,
        CashboxCard,
        CashboxCardMovement,
      ],
      synchronize: false,
      extra: { max: 10 },
    });
    await db.initialize();
    const runner = db.createQueryRunner();
    await new CreateCashboxCards1716000000105().up(runner);
    await new CashboxCardDetails1716000000161().up(runner);
    await runner.release();

    cards = new CashboxCardService(db, activityLog as never, realtime as never);
    checks = new ShiftAccountCheckService(db, activityLog as never);
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
  const cardRepo = () => db.getRepository(CashboxCard);
  const movementCount = () => db.getRepository(CashboxCardMovement).count();
  const cashboxOf = (branchId?: string) =>
    branchId
      ? cashboxRepo().findOneByOrFail({
          user_id: branchId,
          cashbox_type: Cashbox_type.BRANCH,
        })
      : cashboxRepo().findOneByOrFail({
          user_id: '0',
          cashbox_type: Cashbox_type.MAIN,
        });

  beforeEach(async () => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    await db.query(
      `TRUNCATE TABLE "finance_schema"."cashbox_card_movements",
        "finance_schema"."cashbox_cards", "finance_schema"."cashbox_history",
        "finance_schema"."shift_account_checks", "finance_schema"."finance_settings",
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
        user_id: BRANCH,
        cashbox_type: Cashbox_type.BRANCH,
        balance: 300_000,
        balance_cash: 250_000,
        balance_card: 50_000,
      }),
    ]);
    activityLog.log.mockClear();
    realtime.cashboxCardChanged.mockClear();
  });

  /** Invariant SHU kassa uchun: Σ kartalar == balance_card; balance == naqd + karta. */
  const expectInvariant = async (branchId?: string) => {
    const list: any = await cards.listCards({
      include_inactive: true,
      ...(branchId ? { branch_id: branchId } : {}),
    });
    const cashbox = await cashboxOf(branchId);
    const sum = list.data.cards.reduce(
      (s: number, c: { balance: number }) => s + c.balance,
      0,
    );
    expect(sum).toBeCloseTo(Number(cashbox.balance_card), 2);
    expect(list.data.total_card).toBeCloseTo(Number(cashbox.balance_card), 2);
    expect(list.data.in_sync).toBe(true);
    expect(Number(cashbox.balance)).toBeCloseTo(
      Number(cashbox.balance_cash) + Number(cashbox.balance_card),
      2,
    );
    return { list: list.data, cashbox };
  };

  const balancesOf = (list: {
    cards: Array<{ name: string; balance: number }>;
  }) => list.cards.map((c) => [c.name, c.balance]);

  const create = async (name: string, branchId?: string): Promise<string> => {
    const res: any = await cards.createCard({
      name,
      created_by: '1',
      ...(branchId ? { branch_id: branchId } : {}),
    });
    return String(res.data.card.id);
  };
  const defaultId = async (branchId?: string): Promise<string> => {
    const list: any = await cards.listCards(
      branchId ? { branch_id: branchId } : {},
    );
    return String(list.data.cards.find((c: any) => c.is_default).id);
  };
  /** Asosiy kartadan nomli kartaga pul (o'tkazma). */
  const fund = async (cardId: string, amount: number, branchId?: string) =>
    cards.transfer({
      from_card_id: await defaultId(branchId),
      to_card_id: cardId,
      amount,
      comment: 'test',
      created_by: '1',
    });
  const openShift = async (cashboxUserId = '0') =>
    db.getRepository(Shift).save(
      db.getRepository(Shift).create({
        cashbox_user_id: cashboxUserId,
        opened_by: '1',
        opened_at: new Date(),
        status: ShiftStatus.OPEN,
      }),
    );
  const lastRealtime = () =>
    realtime.cashboxCardChanged.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;

  it('⭐ qoldiq 0: soft-delete, ro`yxatdan (include_inactive bilan ham) yo`qoladi, nomi qayta ishlatiladi; takror — 404', async () => {
    const humo = await create('Humo 8600');
    await create('Uzcard');

    const res: any = await cards.deleteCard({ id: humo, deleted_by: '7' });

    expect(res).toMatchObject({
      statusCode: 200,
      message: "Karta o'chirildi",
      data: {
        card: {
          id: humo,
          name: 'Humo 8600',
          balance: 0,
          is_active: false,
          is_deleted: true,
        },
        movement: null,
        moved_amount: 0,
        idempotent: false,
      },
    });
    const row = await cardRepo().findOneByOrFail({ id: humo });
    expect(row).toMatchObject({ isDeleted: true, is_active: false });
    expect(Number(row.balance)).toBe(0);
    expect(await movementCount()).toBe(0);

    const { list } = await expectInvariant();
    expect(list.cards.map((c: any) => c.name)).toEqual([
      'Asosiy karta',
      'Uzcard',
    ]);
    const active: any = await cards.listCards();
    expect(active.data.cards.map((c: any) => c.name)).toEqual([
      'Asosiy karta',
      'Uzcard',
    ]);

    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'CashboxCard',
        entity_id: humo,
        action: 'finance.card_deleted',
        user_id: '7',
        description: '"Humo 8600" kartasi o\'chirildi',
      }),
    );
    expect(lastRealtime()).toMatchObject({
      action: 'deleted',
      card_ids: [humo],
      movement_id: null,
      cashbox_type: 'main',
    });

    // Nom bo'shadi (partial unique indeks o'chirilganni hisobga olmaydi).
    const again = await create('humo 8600');
    expect(again).not.toBe(humo);

    // O'chirilgan kartada har qanday amal — 404 (takror ham).
    await expect(cards.deleteCard({ id: humo })).rejects.toMatchObject({
      error: { statusCode: 404, message: 'Karta topilmadi' },
    });
    await expect(cards.getLedger({ id: humo })).rejects.toMatchObject({
      error: { statusCode: 404 },
    });
  });

  it('arxivlangan karta (qoldiq 0) ham o`chiriladi', async () => {
    const humo = await create('Humo');
    await cards.setCardActive({ id: humo, is_active: false });
    const res: any = await cards.deleteCard({ id: humo });
    expect(res.data.card).toMatchObject({ is_active: false, is_deleted: true });
    const all: any = await cards.listCards({ include_inactive: true });
    expect(all.data.cards).toHaveLength(1);
  });

  it('Asosiy karta — 400; manfiy saqlangan qoldiq — 400 (jimgina tuzatilmaydi)', async () => {
    const def = await defaultId();
    await expect(cards.deleteCard({ id: def })).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message:
          "Asosiy kartani o'chirib bo'lmaydi — avval boshqa kartani asosiy qiling",
      },
    });

    const humo = await create('Humo');
    await cardRepo().update({ id: humo }, { balance: -5 });
    await expect(
      cards.deleteCard({ id: humo, move_to: 'cash' }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/manfiy/) },
    });
    const row = await cardRepo().findOneByOrFail({ id: humo });
    expect(row.isDeleted).toBe(false);
    expect(Number(row.balance)).toBe(-5);
  });

  it('qoldiq > 0, move_to yo`q — 400, hech narsa o`zgarmaydi; move_to noto`g`ri — 400', async () => {
    const humo = await create('Humo');
    await fund(humo, 60_000);

    await expect(cards.deleteCard({ id: humo })).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message:
          "Kartada 60000 so'm bor — o'chirishdan oldin qoldiqni boshqa kartaga yoki naqd kassaga o'tkazing",
      },
    });
    await expect(
      cards.deleteCard({ id: humo, move_to: 'bank' as never }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });

    const { list } = await expectInvariant();
    expect(balancesOf(list)).toEqual([
      ['Asosiy karta', 40_000],
      ['Humo', 60_000],
    ]);
    expect(await movementCount()).toBe(1);
    expect(realtime.cashboxCardChanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deleted' }),
      expect.anything(),
    );
  });

  it('⭐ qoldiq boshqa nomli kartaga: CARD_TO_CARD harakat, balance_card o`zgarmaydi; jurnal summa + manzil', async () => {
    const humo = await create('Humo');
    const uzcard = await create('Uzcard');
    await fund(humo, 60_000);
    await fund(uzcard, 10_000);

    const res: any = await cards.deleteCard({
      id: humo,
      move_to: 'card',
      to_card_id: uzcard,
      deleted_by: '7',
    });

    expect(res.data).toMatchObject({
      moved_amount: 60_000,
      idempotent: false,
      card: { id: humo, balance: 0, is_deleted: true },
      movement: {
        type: CardMovementType.CARD_TO_CARD,
        from_card_id: humo,
        to_card_id: uzcard,
        amount: 60_000,
        balance_after_from: 0,
        balance_after_to: 70_000,
        comment: '"Humo" kartasi o\'chirildi — qoldiq o\'tkazildi',
        created_by: '7',
      },
    });
    const { list, cashbox } = await expectInvariant();
    expect(cashbox).toMatchObject({ balance_card: 100_000, balance: 600_000 });
    expect(balancesOf(list)).toEqual([
      ['Asosiy karta', 30_000],
      ['Uzcard', 70_000],
    ]);

    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'finance.card_deleted',
        description:
          '"Humo" kartasi o\'chirildi — qoldiq 60000 so\'m "Uzcard" kartasiga o\'tkazildi',
        new_value: expect.objectContaining({
          moved_amount: 60_000,
          move_to: 'card',
          to_card_id: uzcard,
        }),
      }),
    );
    expect(lastRealtime()).toMatchObject({
      action: 'deleted',
      card_ids: [humo, uzcard],
      movement_id: res.data.movement.id,
    });

    // Maqsad karta ko'chirmasida — kirim; harakatlar ro'yxati o'chirilgan
    // karta nomini saqlaydi.
    const ledger: any = await cards.getLedger({ id: uzcard });
    expect(ledger.data.items[0]).toMatchObject({
      kind: 'transfer_in',
      delta: 60_000,
      balance_after: 70_000,
      counterparty_card_id: humo,
    });
    const movements: any = await cards.listMovements({ card_id: uzcard });
    expect(movements.data.items[0]).toMatchObject({
      from_card_name: 'Humo',
      to_card_name: 'Uzcard',
    });
  });

  it('⭐ qoldiq Asosiy kartaga (hosila balans o`sadi), izoh berilgan', async () => {
    const humo = await create('Humo');
    const def = await defaultId();
    await fund(humo, 60_000);

    const res: any = await cards.deleteCard({
      id: humo,
      move_to: 'card',
      to_card_id: def,
      comment: 'Karta yopildi',
    });

    expect(res.data.movement).toMatchObject({
      type: CardMovementType.CARD_TO_CARD,
      to_card_id: def,
      amount: 60_000,
      balance_after_from: 0,
      balance_after_to: 100_000,
      comment: 'Karta yopildi',
    });
    const { list } = await expectInvariant();
    expect(balancesOf(list)).toEqual([['Asosiy karta', 100_000]]);
    // Asosiy karta saqlangan balansi doim 0 (CHECK).
    expect(
      Number((await cardRepo().findOneByOrFail({ id: def })).balance),
    ).toBe(0);
    const ledger: any = await cards.getLedger({ id: def });
    expect(ledger.data.items[0]).toMatchObject({
      kind: 'transfer_in',
      delta: 60_000,
      balance_after: 100_000,
    });
  });

  it('⭐ qoldiq naqd kassaga: CARD_TO_CASH, karta/naqd ajratmasi o`zgaradi, umumiy balans o`zgarmaydi', async () => {
    const humo = await create('Humo');
    await fund(humo, 60_000);

    const res: any = await cards.deleteCard({
      id: humo,
      move_to: 'cash',
      // `cash` da e'tiborsiz.
      to_card_id: '999',
    });

    expect(res.data.movement).toMatchObject({
      type: CardMovementType.CARD_TO_CASH,
      from_card_id: humo,
      to_card_id: null,
      amount: 60_000,
      balance_after_from: 0,
      balance_after_to: null,
    });
    const { list, cashbox } = await expectInvariant();
    expect(cashbox).toMatchObject({
      balance: 600_000,
      balance_cash: 560_000,
      balance_card: 40_000,
    });
    expect(balancesOf(list)).toEqual([['Asosiy karta', 40_000]]);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "\"Humo\" kartasi o'chirildi — qoldiq 60000 so'm naqd kassaga o'tkazildi",
      }),
    );
    expect(lastRealtime()).toMatchObject({
      action: 'deleted',
      card_ids: [humo],
      movement_id: res.data.movement.id,
    });
  });

  it('maqsad karta: arxivlangan — 400, o`zi — 400, ko`rsatilmagan — 400, boshqa kassaniki — 404; hech narsa o`zgarmaydi', async () => {
    const humo = await create('Humo');
    const archived = await create('Eski');
    await cards.setCardActive({ id: archived, is_active: false });
    const branchCard = await create('Filial karta', BRANCH);
    await fund(humo, 60_000);

    await expect(
      cards.deleteCard({ id: humo, move_to: 'card', to_card_id: archived }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/arxivlangan/) },
    });
    await expect(
      cards.deleteCard({ id: humo, move_to: 'card', to_card_id: humo }),
    ).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: "Manba va maqsad karta bir xil bo'lmasligi kerak",
      },
    });
    await expect(
      cards.deleteCard({ id: humo, move_to: 'card' }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/to_card_id/) },
    });
    await expect(
      cards.deleteCard({ id: humo, move_to: 'card', to_card_id: branchCard }),
    ).rejects.toMatchObject({
      error: { statusCode: 404, message: 'Karta topilmadi' },
    });

    const row = await cardRepo().findOneByOrFail({ id: humo });
    expect(row.isDeleted).toBe(false);
    expect(Number(row.balance)).toBe(60_000);
    expect(await movementCount()).toBe(1);
    await expectInvariant();
    await expectInvariant(BRANCH);
  });

  it('⭐ nol bilan boshlangan ID (`02`): o`ziga ko`chirish — 400 (karta "tirilmaydi", puli ikki baravar bo`lmaydi); transfer ham; takror — 200', async () => {
    const humo = await create('Humo');
    const uzcard = await create('Uzcard');
    await fund(humo, 60_000);
    const padded = (id: string) => `00${id}`;

    await expect(
      cards.deleteCard({
        id: humo,
        move_to: 'card',
        to_card_id: padded(humo),
      }),
    ).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: "Manba va maqsad karta bir xil bo'lmasligi kerak",
      },
    });
    await expect(
      cards.transfer({
        from_card_id: humo,
        to_card_id: padded(humo),
        amount: 5_000,
        comment: 'x',
      }),
    ).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: "Manba va maqsad karta bir xil bo'lmasligi kerak",
      },
    });
    const row = await cardRepo().findOneByOrFail({ id: humo });
    expect(row).toMatchObject({ isDeleted: false, is_active: true });
    expect(Number(row.balance)).toBe(60_000);
    expect(await movementCount()).toBe(1);
    let state = await expectInvariant();
    expect(balancesOf(state.list)).toEqual([
      ['Asosiy karta', 40_000],
      ['Humo', 60_000],
      ['Uzcard', 0],
    ]);

    // To'g'ri maqsad, ikkala ID ham nol bilan — ishlaydi, harakatda kanonik ID.
    const input = {
      id: padded(humo),
      move_to: 'card' as const,
      to_card_id: padded(uzcard),
      dedup_epoch: 'pad-1',
    };
    const res: any = await cards.deleteCard(input);
    expect(res.data).toMatchObject({
      card: { id: humo, is_deleted: true },
      movement: { from_card_id: humo, to_card_id: uzcard, amount: 60_000 },
    });
    const replay: any = await cards.deleteCard(input);
    expect(replay).toMatchObject({
      statusCode: 200,
      data: { idempotent: true, movement: { id: res.data.movement.id } },
    });
    const retry: any = await cards.deleteCard({ ...input, id: humo });
    expect(retry.data).toMatchObject({ idempotent: true });
    state = await expectInvariant();
    expect(balancesOf(state.list)).toEqual([
      ['Asosiy karta', 40_000],
      ['Uzcard', 60_000],
    ]);
  });

  it('smena darvozasi yoqilgan: qoldiqni ko`chirish smenasiz 400, qoldiqsiz o`chirish o`tadi; smena ochilgach ko`chiradi', async () => {
    const humo = await create('Humo');
    const empty = await create('Bo`sh');
    await fund(humo, 60_000);
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const warn = jest
      .spyOn((cards as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      cards.deleteCard({ id: humo, move_to: 'cash' }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/^Smena/) },
    });
    expect((await cardRepo().findOneByOrFail({ id: humo })).isDeleted).toBe(
      false,
    );

    const zero: any = await cards.deleteCard({ id: empty });
    expect(zero.data.card.is_deleted).toBe(true);

    await openShift('0');
    const moved: any = await cards.deleteCard({ id: humo, move_to: 'cash' });
    expect(moved.data.moved_amount).toBe(60_000);
    await expectInvariant();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('⭐ idempotent: o`sha Idempotency-Key bilan takror — o`sha harakat, 200, ikkinchi yozuv/jurnal yo`q; kalit boshqa amalda — 409', async () => {
    const humo = await create('Humo');
    const uzcard = await create('Uzcard');
    await fund(humo, 60_000);
    const input = {
      id: humo,
      move_to: 'card' as const,
      to_card_id: uzcard,
      deleted_by: '7',
      dedup_epoch: 'del-1',
    };

    const first: any = await cards.deleteCard(input);
    const replay: any = await cards.deleteCard(input);

    expect(replay).toMatchObject({
      statusCode: 200,
      message: "Karta allaqachon o'chirilgan (takroriy so'rov)",
      data: {
        idempotent: true,
        moved_amount: 60_000,
        card: { id: humo, is_deleted: true },
        movement: { id: first.data.movement.id },
      },
    });
    expect(await movementCount()).toBe(2); // fund + o'chirish
    expect(
      activityLog.log.mock.calls.filter(
        ([entry]) => entry.action === 'finance.card_deleted',
      ),
    ).toHaveLength(1);
    const { list } = await expectInvariant();
    expect(balancesOf(list)).toEqual([
      ['Asosiy karta', 40_000],
      ['Uzcard', 60_000],
    ]);

    // Kalit o'tkazmada ishlatilgan — boshqa kartani o'chirishda 409.
    await cards.transfer({
      from_card_id: uzcard,
      to_card_id: await defaultId(),
      amount: 1_000,
      comment: 'x',
      dedup_epoch: 'k-used',
    });
    await expect(
      cards.deleteCard({ id: uzcard, move_to: 'cash', dedup_epoch: 'k-used' }),
    ).rejects.toMatchObject({ error: { statusCode: 409 } });
    expect((await cardRepo().findOneByOrFail({ id: uzcard })).isDeleted).toBe(
      false,
    );
  });

  it('⭐ smena qoralamalari: ochiq smenadagi tasdiqlanmagan qoralama o`chiriladi (hisobot / avto-yopishda yo`q); yopilgan smena tarixi tegilmaydi', async () => {
    const humo = await create('Humo');
    const uzcard = await create('Uzcard');
    const checkRepo = db.getRepository(ShiftAccountCheck);
    const closed = await db.getRepository(Shift).save(
      db.getRepository(Shift).create({
        cashbox_user_id: '0',
        opened_by: '1',
        opened_at: new Date(Date.now() - 86_400_000),
        closed_at: new Date(Date.now() - 3_600_000),
        status: ShiftStatus.CLOSED,
      }),
    );
    const open = await openShift('0');
    // Yopilgan smena (avto-yopish) — tasdiqlanmagan, lekin TARIX.
    const history = await checkRepo.save(
      checkRepo.create({
        shift_id: String(closed.id),
        cashbox_card_id: humo,
        expected_balance: 0,
        photo_file_key: 'old.jpg',
      }),
    );
    const draft = await checkRepo.save(
      checkRepo.create({
        shift_id: String(open.id),
        cashbox_card_id: humo,
        expected_balance: 0,
        photo_file_key: 'humo.jpg',
        photo_uploaded_at: new Date(),
      }),
    );
    const otherDraft = await checkRepo.save(
      checkRepo.create({
        shift_id: String(open.id),
        cashbox_card_id: uzcard,
        expected_balance: 0,
        photo_file_key: 'uzcard.jpg',
        photo_uploaded_at: new Date(),
      }),
    );

    await cards.deleteCard({ id: humo });

    const byId = async (id: string) =>
      (await checkRepo.findOneByOrFail({ id })).isDeleted;
    expect(await byId(String(draft.id))).toBe(true);
    expect(await byId(String(otherDraft.id))).toBe(false);
    expect(await byId(String(history.id))).toBe(false);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'finance.card_deleted',
        metadata: expect.objectContaining({ discarded_shift_drafts: 1 }),
      }),
    );

    const report = await checks.listForShift(String(open.id));
    expect(report.map((row) => row.card_id)).toEqual([uzcard]);
    // Avto-yopish (BE-A: MAIN'da tasdiqlash sukut yoqiq — har faol karta
    // "tasdiqlanmagan" yoziladi): o'chirilgan karta chiqmaydi.
    const auto = (await db.transaction((manager) =>
      checks.recordAtAutoClose(manager, open),
    )) as { accounts: Array<{ card_id: string }> };
    expect(auto.accounts.map((row) => row.card_id)).toEqual([
      await defaultId(),
      uzcard,
    ]);
  });

  it('⭐ filial kassasi: qoldiq naqdga, filial invarianti; boshqa filial doirasi — 403; MAIN tegilmaydi', async () => {
    const card = await create('Filial Humo', BRANCH);
    await fund(card, 20_000, BRANCH);

    await expect(
      cards.deleteCard({ id: card, move_to: 'cash', branch_id: '14' }),
    ).rejects.toMatchObject({ error: { statusCode: 403 } });

    const res: any = await cards.deleteCard({
      id: card,
      move_to: 'cash',
      branch_id: BRANCH,
    });
    expect(res.data).toMatchObject({
      moved_amount: 20_000,
      movement: { type: CardMovementType.CARD_TO_CASH, amount: 20_000 },
    });
    const { list, cashbox } = await expectInvariant(BRANCH);
    expect(cashbox).toMatchObject({
      balance: 300_000,
      balance_cash: 270_000,
      balance_card: 30_000,
    });
    expect(balancesOf(list)).toEqual([['Asosiy karta', 30_000]]);
    expect(lastRealtime()).toMatchObject({
      action: 'deleted',
      cashbox_type: 'branch',
      branch_id: BRANCH,
      card_ids: [card],
    });
    const main = await expectInvariant();
    expect(main.cashbox).toMatchObject({
      balance_cash: 500_000,
      balance_card: 100_000,
    });
  });
});
