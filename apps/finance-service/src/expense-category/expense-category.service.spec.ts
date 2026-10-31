import { BadRequestException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Operation_type, Source_type } from '@app/common';
import {
  CASHBOX_EXPENSE_CATEGORY_SEED,
  CreateCashboxExpenseCategories1716000000129,
} from '../../../../migrations/1716000000129-CreateCashboxExpenseCategories';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import {
  ExpenseCategoryService,
  ExpenseCategoryView,
  resolveSpendExpenseCategory,
} from './expense-category.service';

/**
 * Elchi Pochta №1 — kassa xarajatlari kategoriyalari: seed ro'yxati (PO
 * jadvali bilan aynan), CRUD qoidalari (noyob nom, soft o'chirish, audit
 * jurnali) va qo'lda chiqimdagi kategoriya tekshiruvi. Haqiqiy Postgres
 * bilan — `expense-category.pg.spec.ts`.
 */

/** PO jadvali (Notion "Elchi Pochta" №1) — tartibi bilan. */
const PO_TABLE: Array<[string, string]> = [
  ['Ovqatlanish', 'Xodimlarning ovqati, tushlik'],
  ["Yoqilg'i", 'Benzin, gaz, dizel'],
  ['Avtomobil xarajatlari', "Ta'mirlash, moy almashtirish, ehtiyot qismlar"],
  ['Ijara (arenda)', 'Filial, ombor, ofis ijarasi'],
  ["Kommunal to'lovlar", 'Elektr, suv, gaz, chiqindi'],
  ['Internet va aloqa', 'Internet, telefon, SIM-karta'],
  ['Xodimlar oyligi', 'Oylik, avans, bonus'],
  ['Yetkazib berish', 'Tashqi transport, yuk tashish xizmati'],
  ['Qadoqlash materiallari', 'Paket, skotch, quti, yorliq'],
  ['Ofis xarajatlari', "Qog'oz, ruchka, printer, kanselyariya"],
  ["Ta'mirlash", "Filial, ombor va ofis jihozlarini ta'mirlash"],
  ['Texnika va jihozlar', 'Kompyuter, printer, skaner, mebel'],
  ['Reklama va marketing', 'Telegram, Instagram reklamasi, banner'],
  ['Xizmat xarajatlari', 'Bank komissiyasi, dastur obunalari'],
  ["Soliq va majburiy to'lovlar", 'Soliq, davlat bojlari'],
  ["Tozalik va xo'jalik", "Tozalash vositalari, xo'jalik buyumlari"],
  ['Qaytarilgan pullar', 'Mijozga pul qaytarish'],
];

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('RpcException kutilgan edi');
};

type Res<T> = { statusCode: number; message: string; data: T };

/** Servis javobi (`successRes`) — test ichida aniq tur bilan. */
const result = async <T>(promise: Promise<unknown>) =>
  (await promise) as Res<T>;

type Row = Record<string, unknown>;

function makeEnv(rows: Row[] = []) {
  let seq = 100;
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(0),
    getRawOne: jest.fn().mockResolvedValue({ max: 17 }),
  };
  const manager = {
    find: jest.fn().mockResolvedValue(rows),
    // `findOne(Entity, { where: { id, isDeleted } })` — `rows` dan qidiradi.
    findOne: jest.fn((_entity: unknown, options: { where: Row }) =>
      Promise.resolve(
        rows.find(
          (row) =>
            String(row.id) === String(options?.where?.id) &&
            row.isDeleted === options?.where?.isDeleted,
        ) ?? null,
      ),
    ),
    create: jest.fn((_entity: unknown, dto: Row) => ({ ...dto })),
    save: jest.fn((_entity: unknown, entity: Row) =>
      Promise.resolve({
        createdAt: new Date('2026-10-21T00:00:00Z'),
        updatedAt: new Date('2026-10-21T00:00:00Z'),
        isDeleted: false,
        ...entity,
        id: entity.id ?? String(++seq),
      }),
    ),
    createQueryBuilder: jest.fn(() => qb),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
      work(manager),
    ),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new ExpenseCategoryService(
    dataSource as never,
    activityLog as never,
  );
  return { service, manager, qb, dataSource, activityLog };
}

const category = (extra: Row = {}): Row => ({
  id: '2',
  name: "Yoqilg'i",
  description: 'Benzin, gaz, dizel',
  sort_order: 2,
  isDeleted: false,
  created_by: null,
  updated_by: null,
  createdAt: new Date('2026-10-21T00:00:00Z'),
  updatedAt: new Date('2026-10-21T00:00:00Z'),
  ...extra,
});

describe('Elchi Pochta №1 — seed (migratsiya 129)', () => {
  it('⭐ seed — PO jadvalidagi AYNAN 17 ta kategoriya, shu tartibda', () => {
    expect(
      CASHBOX_EXPENSE_CATEGORY_SEED.map((c) => [c.name, c.description]),
    ).toEqual(PO_TABLE);
    expect(CASHBOX_EXPENSE_CATEGORY_SEED).toHaveLength(17);
    // Nomlar katta-kichik harf farqsiz noyob (partial unique indeks bilan mos).
    const lower = CASHBOX_EXPENSE_CATEGORY_SEED.map((c) =>
      c.name.toLowerCase(),
    );
    expect(new Set(lower).size).toBe(17);
    // Repo seed'lari (Farg'ona va h.k.) kabi oddiy ASCII apostrof.
    for (const { name, description } of CASHBOX_EXPENSE_CATEGORY_SEED) {
      expect(`${name}${description}`).not.toMatch(/[ʻʼ‘’`]/);
      expect(name.length).toBeLessThanOrEqual(100);
    }
  });

  it('up(): parametrli INSERT, sort_order 1..17, ON CONFLICT (lower(name)) — takroriy ishga tushirish dublikat yozmaydi', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
    await new CreateCashboxExpenseCategories1716000000129().up(
      queryRunner as never,
    );
    const calls = queryRunner.query.mock.calls as Array<
      [string, Array<string | number>?]
    >;
    const insert = calls.find(([sql]) =>
      /INSERT INTO "finance_schema"\."cashbox_expense_categories"/.test(sql),
    );
    expect(insert).toBeDefined();
    const [sql, params = []] = insert!;
    expect(sql).toMatch(
      /ON CONFLICT \(\(lower\("name"\)\)\) WHERE "is_deleted" = false\s+DO NOTHING/,
    );
    // Apostrofli nomlar SQL matniga tushmaydi — faqat parametr.
    expect(sql).not.toContain("Yoqilg'i");
    const triples: Array<[string, string, number]> = [];
    for (let i = 0; i < params.length; i += 3) {
      triples.push([
        params[i] as string,
        params[i + 1] as string,
        params[i + 2] as number,
      ]);
    }
    expect(triples).toEqual(
      PO_TABLE.map(([name, description], index) => [
        name,
        description,
        index + 1,
      ]),
    );
    const ddl = calls.map(([q]) => q).join('\n');
    expect(ddl).toContain('"UQ_CASHBOX_EXPENSE_CATEGORY_NAME"');
    expect(ddl).toMatch(/\(lower\("name"\)\)\s+WHERE "is_deleted" = false/);
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "expense_category_id"');
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "expense_category_name"');
  });
});

describe('Elchi Pochta №1 — ExpenseCategoryService', () => {
  it('ro`yxat: sukut — faqat o`chirilmaganlar, sort_order → id tartibida; include_deleted — hammasi', async () => {
    const env = makeEnv([category()]);
    const res = await result<{ items: ExpenseCategoryView[] }>(
      env.service.list(),
    );
    expect(env.manager.find).toHaveBeenCalledWith(CashboxExpenseCategory, {
      where: { isDeleted: false },
      order: { isDeleted: 'ASC', sort_order: 'ASC', id: 'ASC' },
    });
    expect(res).toMatchObject({ statusCode: 200 });
    const createdAt = new Date('2026-10-21T00:00:00Z');
    expect(res.data.items).toEqual([
      {
        id: '2',
        name: "Yoqilg'i",
        description: 'Benzin, gaz, dizel',
        sort_order: 2,
        is_deleted: false,
        created_by: null,
        updated_by: null,
        created_at: createdAt,
        updated_at: createdAt,
      },
    ]);

    await env.service.list({ include_deleted: 'true' });
    expect(env.manager.find).toHaveBeenLastCalledWith(
      CashboxExpenseCategory,
      expect.objectContaining({ where: {} }),
    );
  });

  it('qo`shish: nom tozalanadi, sort_order berilmasa — oxiriga (MAX+1), audit jurnali', async () => {
    const env = makeEnv();
    const res = await result<{ category: ExpenseCategoryView }>(
      env.service.create({
        name: '  Kuryer   jarimalari ',
        description: '  Yo`l jarimalari ',
        created_by: '1',
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.data.category).toMatchObject({
      name: 'Kuryer jarimalari',
      description: 'Yo`l jarimalari',
      sort_order: 18,
      created_by: '1',
      is_deleted: false,
    });
    expect(env.qb.andWhere).toHaveBeenCalledWith(
      'lower(c.name) = lower(:name)',
      { name: 'Kuryer jarimalari' },
    );
    expect(env.activityLog.log).toHaveBeenCalledWith({
      entity_type: 'CashboxExpenseCategory',
      entity_id: res.data.category.id,
      action: 'finance.expense_category_created',
      new_value: {
        name: 'Kuryer jarimalari',
        description: 'Yo`l jarimalari',
        sort_order: 18,
      },
      user_id: '1',
      description: `"Kuryer jarimalari" xarajat kategoriyasi qo'shildi`,
    });

    await env.service.create({ name: 'Boshqa', sort_order: 0 });
    expect(env.manager.save).toHaveBeenLastCalledWith(
      CashboxExpenseCategory,
      expect.objectContaining({ sort_order: 0, description: null }),
    );
  });

  it('⭐ qo`shish: bir xil nom (katta-kichik harf farqsiz) — 409; parallel so`rov (23505) ham 409', async () => {
    const env = makeEnv();
    env.qb.getCount.mockResolvedValueOnce(1);
    expect(await rpcError(env.service.create({ name: "YOQILG'I" }))).toEqual({
      statusCode: 409,
      message: `"YOQILG'I" nomli kategoriya allaqachon bor`,
    });
    expect(env.manager.save).not.toHaveBeenCalled();

    env.manager.save.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );
    expect(
      (await rpcError(env.service.create({ name: 'Yangi' }))).statusCode,
    ).toBe(409);
    expect(env.activityLog.log).not.toHaveBeenCalled();
  });

  it('qo`shish: nom bo`sh / 100+ belgi, tavsif 500+, sort_order manfiy / kasr — 400', async () => {
    const env = makeEnv();
    for (const input of [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 'Ok', description: 'x'.repeat(501) },
      { name: 'Ok', sort_order: -1 },
      { name: 'Ok', sort_order: 1.5 },
      { name: { $ne: '' } },
    ]) {
      expect(
        (await rpcError(env.service.create(input as never))).statusCode,
      ).toBe(400);
    }
    expect(env.manager.save).not.toHaveBeenCalled();
  });

  it('tahrirlash: faqat o`zgargan maydonlar jurnalga; nom o`zgarsa "eski → yangi"; description: null — tozalash', async () => {
    const row = category();
    const env = makeEnv([row]);
    const res = await result<{ category: ExpenseCategoryView }>(
      env.service.update({
        id: '2',
        name: "Yoqilg'i va moy",
        description: null,
        sort_order: 2,
        updated_by: '1',
      }),
    );
    expect(res).toMatchObject({
      statusCode: 200,
      message: 'Kategoriya yangilandi',
    });
    expect(res.data.category).toMatchObject({
      name: "Yoqilg'i va moy",
      description: null,
      sort_order: 2,
      updated_by: '1',
    });
    // Qator FOR UPDATE bilan olinadi.
    expect(env.manager.findOne).toHaveBeenCalledWith(CashboxExpenseCategory, {
      where: { id: '2', isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    // Nom takrori o'zini hisobga olmay tekshiriladi.
    expect(env.qb.andWhere).toHaveBeenCalledWith('c.id <> :exceptId', {
      exceptId: '2',
    });
    expect(env.activityLog.log).toHaveBeenCalledWith({
      entity_type: 'CashboxExpenseCategory',
      entity_id: '2',
      action: 'finance.expense_category_updated',
      old_value: { name: "Yoqilg'i", description: 'Benzin, gaz, dizel' },
      new_value: { name: "Yoqilg'i va moy", description: null },
      user_id: '1',
      description: `Xarajat kategoriyasi nomi: "Yoqilg'i" → "Yoqilg'i va moy"`,
    });
  });

  it('tahrirlash: topilmasa / o`chirilgan — 404; takror nom — 409; bo`sh so`rov — 400', async () => {
    const env = makeEnv([category({ id: '3', isDeleted: true })]);
    expect(await rpcError(env.service.update({ id: '3', name: 'X' }))).toEqual({
      statusCode: 404,
      message: 'Kategoriya topilmadi',
    });

    const env2 = makeEnv([category()]);
    env2.qb.getCount.mockResolvedValueOnce(1);
    expect(
      (await rpcError(env2.service.update({ id: '2', name: 'Ovqatlanish' })))
        .statusCode,
    ).toBe(409);
    expect(env2.manager.save).not.toHaveBeenCalled();

    expect(
      await rpcError(env2.service.update({ id: '2', updated_by: '1' })),
    ).toEqual({
      statusCode: 400,
      message: "O'zgartirish uchun name, description yoki sort_order bering",
    });
    expect(
      (await rpcError(env2.service.update({ id: 'x', name: 'A' }))).statusCode,
    ).toBe(400);
    expect(env2.activityLog.log).not.toHaveBeenCalled();
  });

  it('⭐ o`chirish — SOFT: is_deleted = true, updated_by; ikkinchi marta — 404; audit jurnali', async () => {
    const row = category();
    const env = makeEnv([row]);
    const res = await result<{ category: ExpenseCategoryView }>(
      env.service.remove({ id: '2', deleted_by: '1' }),
    );
    expect(res).toMatchObject({
      statusCode: 200,
      message: "Kategoriya o'chirildi",
    });
    expect(res.data.category).toMatchObject({
      id: '2',
      name: "Yoqilg'i",
      is_deleted: true,
      updated_by: '1',
    });
    // Qator saqlanadi (DELETE emas) — tarix nomi yo'qolmaydi.
    expect(env.manager.save).toHaveBeenCalledWith(
      CashboxExpenseCategory,
      expect.objectContaining({ id: '2', isDeleted: true }),
    );
    expect(env.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'CashboxExpenseCategory',
        entity_id: '2',
        action: 'finance.expense_category_deleted',
        user_id: '1',
        description: `"Yoqilg'i" xarajat kategoriyasi o'chirildi`,
      }),
    );

    row.isDeleted = true;
    expect(await rpcError(env.service.remove({ id: '2' }))).toEqual({
      statusCode: 404,
      message: 'Kategoriya topilmadi',
    });
  });
});

describe('Elchi Pochta №1 — resolveSpendExpenseCategory (qo`lda chiqim)', () => {
  const manualExpense = {
    operation_type: Operation_type.EXPENSE,
    source_type: Source_type.MANUAL_EXPENSE,
  };

  it('berilmasa — null, bazaga murojaat yo`q (avvalgi xatti-harakat)', async () => {
    const manager = { findOne: jest.fn() };
    for (const value of [undefined, null, '']) {
      await expect(
        resolveSpendExpenseCategory(manager as never, {
          ...manualExpense,
          expense_category_id: value,
        }),
      ).resolves.toBeNull();
    }
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('faol kategoriya — { id, name }; qator FOR SHARE bilan o`qiladi', async () => {
    const manager = {
      findOne: jest.fn().mockResolvedValue(category({ id: '5' })),
    };
    await expect(
      resolveSpendExpenseCategory(manager as never, {
        ...manualExpense,
        expense_category_id: '5',
      }),
    ).resolves.toEqual({
      id: '5',
      name: "Yoqilg'i",
      ledger_category: 'other',
    });
    expect(manager.findOne).toHaveBeenCalledWith(CashboxExpenseCategory, {
      where: { id: '5', isDeleted: false },
      lock: { mode: 'pessimistic_read' },
    });
  });

  it('⭐ o`chirilgan / mavjud bo`lmagan kategoriya — 400', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue(null) };
    const error = await resolveSpendExpenseCategory(manager as never, {
      ...manualExpense,
      expense_category_id: '99',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      "Xarajat kategoriyasi topilmadi yoki o'chirilgan — ro'yxatdan faol kategoriya tanlang",
    );
  });

  it('raqam bo`lmagan id va qo`lda chiqimdan boshqa oyoq (kirim, qo`shimcha xarajat) — 400', async () => {
    const manager = { findOne: jest.fn() };
    for (const input of [
      { ...manualExpense, expense_category_id: 'abc' },
      { ...manualExpense, expense_category_id: { id: 1 } },
      {
        operation_type: Operation_type.INCOME,
        source_type: Source_type.MANUAL_INCOME,
        expense_category_id: '2',
      },
      {
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.EXTRA_COST,
        expense_category_id: '2',
      },
    ]) {
      await expect(
        resolveSpendExpenseCategory(manager as never, input),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(manager.findOne).not.toHaveBeenCalled();
  });
});
