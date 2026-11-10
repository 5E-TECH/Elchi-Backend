import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Cashbox_type } from '@app/common';
import { CashboxCardDetails1716000000161 } from '../../../../migrations/1716000000161-CashboxCardDetails';
import {
  SHIFT_CHECK_BRANCH_KEY,
  ShiftCheckMainDefaults1716000000215,
} from '../../../../migrations/1716000000215-ShiftCheckMainDefaults';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import { ShiftAccountCheckService } from './shift-account-check.service';

/**
 * BE-A — migratsiya 215 (MAIN smena tekshiruvi sukut yoqiq) haqiqiy
 * Postgres'da. Migratsiya `finance_schema` ga qattiq bog'langan, shu bois
 * spec o'z vaqtinchalik bazasini yaratadi va oxirida o'chiradi
 * (`FINANCE_PG_TEST_URI` / `FINANCE_OPERATOR_PG_TEST_URI` faqat ulanish uchun;
 * berilmasa skip).
 *
 *  • sozlamalar: 3 ta MAIN kaliti `true` ga (superadmin qiymati va
 *    o'chirilgan qator ustiga), filial kaliti `false` — faqat yo'q bo'lsa;
 *  • kartalar: faqat MAIN kassaning o'chirilmagan kartalari true / true;
 *    filial, kuryer, o'chirilgan karta / kassa — tegilmaydi; balanslar
 *    o'zgarmaydi;
 *  • qayta up() — hech narsa o'zgarmaydi (`updatedAt` ham);
 *  • down() — avvalgi sukutlar, karta bayroqlari qoladi; qayta down() xatosiz;
 *  • jadval bo'lmasa up() / down() xatosiz.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const MAIN_KEYS = [
  'shift.account_check.enabled',
  'shift.photo.required',
  'shift.ai_check.enabled',
];

describePg('BE-A migratsiya 215 — MAIN smena tekshiruvi sukutlari', () => {
  const dbName = `spec_shiftmain_${randomUUID().replace(/-/g, '').slice(0, 10)}_test`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new ShiftCheckMainDefaults1716000000215();

  /** TypeORM kabi: bitta tranzaksiyada. */
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
      entities: [Cashbox, CashboxHistory, CashboxCard, FinanceSetting],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA "finance_schema"');
    await db.synchronize();
    // 161 dagi CHECK (AI faqat rasm bilan) — prod jadvali kabi.
    const runner = db.createQueryRunner();
    try {
      await new CashboxCardDetails1716000000161().up(runner);
    } finally {
      await runner.release();
    }
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  type Ids = Record<
    'm1' | 'm2' | 'm3' | 'm4' | 'd1' | 'b1' | 'b2' | 'c1',
    string
  >;
  let ids: Ids;

  const seed = async () => {
    await db.query(
      `TRUNCATE TABLE "finance_schema"."cashbox_cards",
         "finance_schema"."finance_settings", "finance_schema"."cashboxes"
       RESTART IDENTITY CASCADE`,
    );
    const cashboxes = db.getRepository(Cashbox);
    const [main, deletedMain, branch, courier] = await cashboxes.save([
      cashboxes.create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 500_000,
        balance_cash: 200_000,
        balance_card: 300_000,
      }),
      cashboxes.create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        isDeleted: true,
      }),
      cashboxes.create({
        user_id: '13',
        cashbox_type: Cashbox_type.BRANCH,
        balance: 50_000,
        balance_card: 50_000,
      }),
      cashboxes.create({
        user_id: '501',
        cashbox_type: Cashbox_type.FOR_COURIER,
      }),
    ]);
    const repo = db.getRepository(CashboxCard);
    const card = (
      cashbox: Cashbox,
      name: string,
      extra: Partial<CashboxCard> = {},
    ) =>
      repo.create({
        cashbox_id: String(cashbox.id),
        name,
        balance: 0,
        ...extra,
      });
    const saved = await repo.save([
      card(main, 'Asosiy karta', { is_default: true }),
      // Superadmin avval faqat rasmni yoqqan.
      card(main, 'Humo', {
        balance: 100_000,
        require_photo_on_shift_close: true,
      }),
      card(main, 'Arxiv', { balance: 5_000, is_active: false }),
      card(main, "O'chirilgan", { isDeleted: true }),
      card(deletedMain, 'Eski kassa kartasi'),
      card(branch, 'Asosiy karta', { is_default: true }),
      card(branch, 'Filial Humo', {
        balance: 20_000,
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
      }),
      card(courier, 'Kuryer kartasi'),
    ]);
    const [m1, m2, m3, m4, d1, b1, b2, c1] = saved.map((row) => String(row.id));
    ids = { m1, m2, m3, m4, d1, b1, b2, c1 };

    const settings = db.getRepository(FinanceSetting);
    await settings.save([
      settings.create({
        key: 'shift.account_check.enabled',
        value: false,
        updated_by: '1',
      }),
      settings.create({
        key: 'shift.ai_check.enabled',
        value: false,
        updated_by: '1',
      }),
      settings.create({
        key: 'shift.photo.required',
        value: false,
        isDeleted: true,
      }),
      settings.create({ key: 'shift.auto_close.enabled', value: true }),
    ]);
  };

  const flags = async (): Promise<Record<string, [boolean, boolean]>> => {
    const rows: Array<{
      id: string;
      require_photo_on_shift_close: boolean;
      ai_check_enabled: boolean;
    }> = await db.query(
      `SELECT "id", "require_photo_on_shift_close", "ai_check_enabled"
         FROM "finance_schema"."cashbox_cards" ORDER BY "id"`,
    );
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return Object.fromEntries(
      Object.entries(ids).map(([name, id]) => {
        const row = byId.get(id)!;
        return [name, [row.require_photo_on_shift_close, row.ai_check_enabled]];
      }),
    );
  };

  const settingRows = async () =>
    Object.fromEntries(
      (
        await db.query(
          `SELECT "key", "value", "is_deleted", "updated_by"
             FROM "finance_schema"."finance_settings" ORDER BY "key"`,
        )
      ).map(
        (row: {
          key: string;
          value: unknown;
          is_deleted: boolean;
          updated_by: string | null;
        }) => [
          row.key,
          {
            value: row.value,
            is_deleted: row.is_deleted,
            updated_by: row.updated_by,
          },
        ],
      ),
    );

  /** Pul va jadvalning to'liq holati (qayta up() — `updatedAt` ham o'zgarmasin). */
  const snapshot = async () => ({
    cashboxes: await db.query(
      `SELECT "id", "balance", "balance_cash", "balance_card", "updatedAt"
         FROM "finance_schema"."cashboxes" ORDER BY "id"`,
    ),
    cards: await db.query(
      `SELECT * FROM "finance_schema"."cashbox_cards" ORDER BY "id"`,
    ),
    settings: await db.query(
      `SELECT * FROM "finance_schema"."finance_settings" ORDER BY "key"`,
    ),
  });

  it('up(): MAIN kalitlari true (ustiga yoziladi), filial kaliti false; faqat MAIN kartalari true / true; pul o‘zgarmaydi', async () => {
    await seed();
    const before = await snapshot();
    await run('up');

    const settings = await settingRows();
    for (const key of MAIN_KEYS) {
      expect(settings[key]).toEqual({
        value: true,
        is_deleted: false,
        updated_by: null,
      });
    }
    expect(settings[SHIFT_CHECK_BRANCH_KEY]).toEqual({
      value: false,
      is_deleted: false,
      updated_by: null,
    });
    // Boshqa kalitga tegilmaydi.
    expect(settings['shift.auto_close.enabled']).toEqual({
      value: true,
      is_deleted: false,
      updated_by: null,
    });

    expect(await flags()).toEqual({
      m1: [true, true],
      m2: [true, true],
      m3: [true, true], // arxivlangan, lekin o'chirilmagan — MAIN kartasi
      m4: [false, false], // o'chirilgan karta
      d1: [false, false], // o'chirilgan MAIN kassasi
      b1: [false, false], // filial
      b2: [true, true], // filial — superadmin qo'ygani o'zgarmaydi
      c1: [false, false], // kuryer kassasi
    });

    // PUL INVARIANTI: kassa va karta balanslari o'zgarmaydi.
    const after = await snapshot();
    expect(after.cashboxes).toEqual(before.cashboxes);
    expect(
      after.cards.map((row: { id: string; balance: string }) => [
        row.id,
        row.balance,
      ]),
    ).toEqual(
      before.cards.map((row: { id: string; balance: string }) => [
        row.id,
        row.balance,
      ]),
    );

    // Servis migratsiyadan keyingi holatni shunday o'qiydi.
    const checks = new ShiftAccountCheckService(db, {} as never);
    expect(await checks.loadSettingsFor('0')).toEqual({
      account_check_enabled: true,
      photo_required: true,
      ai_check_enabled: true,
    });
    expect(await checks.loadSettingsFor('13')).toEqual({
      account_check_enabled: false,
      photo_required: true,
      ai_check_enabled: true,
    });
  });

  it('qayta up() — hech narsa o‘zgarmaydi (updatedAt ham); superadmin qo‘ygan filial kaliti saqlanadi', async () => {
    await seed();
    await run('up');
    await db.query(
      `UPDATE "finance_schema"."finance_settings"
          SET "value" = 'true'::jsonb, "updated_by" = 1
        WHERE "key" = $1`,
      [SHIFT_CHECK_BRANCH_KEY],
    );
    const once = await snapshot();
    await run('up');
    expect(await snapshot()).toEqual(once);
    expect((await settingRows())[SHIFT_CHECK_BRANCH_KEY]).toEqual({
      value: true,
      is_deleted: false,
      updated_by: '1',
    });
  });

  it('sozlama qatori umuman yo‘q (toza baza) — 4 ta qator yaratiladi', async () => {
    await seed();
    await db.query('TRUNCATE TABLE "finance_schema"."finance_settings"');
    await run('up');
    expect(await settingRows()).toEqual({
      'shift.account_check.branch_enabled': {
        value: false,
        is_deleted: false,
        updated_by: null,
      },
      'shift.account_check.enabled': {
        value: true,
        is_deleted: false,
        updated_by: null,
      },
      'shift.ai_check.enabled': {
        value: true,
        is_deleted: false,
        updated_by: null,
      },
      'shift.photo.required': {
        value: true,
        is_deleted: false,
        updated_by: null,
      },
    });
  });

  it('down(): avvalgi sukutlar (tasdiqlash / AI false), filial kaliti o‘chadi, karta bayroqlari qoladi; qayta down() va up() xatosiz', async () => {
    await seed();
    await run('up');
    const flagsAfterUp = await flags();
    await run('down');
    const settings = await settingRows();
    expect(settings['shift.account_check.enabled'].value).toBe(false);
    expect(settings['shift.ai_check.enabled'].value).toBe(false);
    expect(settings['shift.photo.required'].value).toBe(true);
    expect(settings[SHIFT_CHECK_BRANCH_KEY]).toBeUndefined();
    expect(await flags()).toEqual(flagsAfterUp);

    const once = await snapshot();
    await run('down');
    expect(await snapshot()).toEqual(once);

    await run('up');
    expect((await settingRows())['shift.account_check.enabled'].value).toBe(
      true,
    );
  });

  it('jadvallar yo‘q — up() / down() xatosiz o‘tadi', async () => {
    await db.query('DROP SCHEMA "finance_schema" CASCADE');
    await db.query('CREATE SCHEMA "finance_schema"');
    await expect(run('up')).resolves.toBeUndefined();
    await expect(run('down')).resolves.toBeUndefined();
  });
});
