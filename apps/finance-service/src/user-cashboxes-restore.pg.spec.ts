import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type, Operation_type, Roles, Source_type } from '@app/common';
import {
  BRANCH_CASHBOX_TYPE,
  RestoreUserCashboxes1716000000234,
  USER_CASHBOX_TYPE_BY_ROLE,
} from '../../../migrations/1716000000234-RestoreUserCashboxes';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift } from './entities/shift.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';

/**
 * Migratsiya 234 — kuryer / market / menejerli filial kassalarini tiklash,
 * HAQIQIY Postgres.
 *
 * Prod holati (baza tozalanishi, 2026-11-11..14): kassalar ketgan,
 * foydalanuvchilar qolgan — sotuv 404 «Market kassasi topilmadi» /
 * «Kuryer kassasi topilmadi», kassa tafsiloti 404 «Kassa topilmadi».
 * Kuryer / market kassasini kod o'zi tiklamaydi.
 *
 * O'z vaqtinchalik bazasi (oxirida o'chiriladi); `FINANCE_PG_TEST_URI` faqat
 * ulanish uchun (faqat lokal xost).
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const localHost = (() => {
  if (!pgUri) return false;
  return ['127.0.0.1', 'localhost'].includes(new URL(pgUri).hostname);
})();
const describePg = localHost ? describe : describe.skip;

type CashboxRow = {
  id: string;
  user_id: string;
  type: string;
  balance: number;
  is_deleted: boolean;
};

/** RpcException yuki (`{ statusCode, message }`). */
const rpcError = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('RpcException kutilgan edi');
    },
    (error: { getError: () => unknown }) =>
      error.getError() as { statusCode: number; message: string },
  );

describePg('Migratsiya 234 — foydalanuvchi kassalarini tiklash', () => {
  const dbName = `spec_usercb_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  const restore = new RestoreUserCashboxes1716000000234();
  const ids: Record<string, string> = {};

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  /** TypeORM kabi: bitta tranzaksiyada. */
  const runRestore = async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await restore.up(runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  const cashboxes = () =>
    db.query<CashboxRow[]>(
      `SELECT "id"::text AS id, "user_id"::text AS user_id,
              "cashbox_type"::text AS type, "balance"::float AS balance,
              "is_deleted"
         FROM "finance_schema"."cashboxes"
        ORDER BY "id"`,
    );
  const live = async () =>
    (await cashboxes())
      .filter((c) => !c.is_deleted)
      .map((c) => `${c.type}:${c.user_id}`)
      .sort();

  const addUser = async (key: string, role: string, isDeleted = false) => {
    const [row] = await db.query<Array<{ id: string }>>(
      `INSERT INTO "identity_schema"."admins" ("name", "role", "is_deleted")
       VALUES ($1, $2, $3) RETURNING "id"::text AS id`,
      [key, role, isDeleted],
    );
    ids[key] = row.id;
  };
  const addBranch = async (key: string, type: string, isDeleted = false) => {
    const [row] = await db.query<Array<{ id: string }>>(
      `INSERT INTO "branch_schema"."branches" ("name", "type", "is_deleted")
       VALUES ($1, $2, $3) RETURNING "id"::text AS id`,
      [key, type, isDeleted],
    );
    ids[key] = row.id;
  };
  const addMember = async (
    branch: string,
    user: string,
    role: string,
    isDeleted = false,
  ) => {
    await db.query(
      `INSERT INTO "branch_schema"."branch_users" ("branch_id", "user_id", "role", "is_deleted")
       VALUES ($1, $2, $3, $4)`,
      [ids[branch], ids[user], role, isDeleted],
    );
  };
  const addCashbox = async (
    userId: string,
    type: string,
    balance = 0,
    isDeleted = false,
  ) => {
    await db.query(
      `INSERT INTO "finance_schema"."cashboxes"
         ("user_id", "cashbox_type", "balance", "balance_cash", "balance_card", "is_deleted")
       VALUES ($1, $2, $3, $3, 0, $4)`,
      [userId, type, balance, isDeleted],
    );
  };
  /** Prod'dagi tozalash: kassalar (va CASCADE bilan tarix) ketadi. */
  const wipeCashboxes = async () => {
    await db.query(
      `TRUNCATE TABLE "finance_schema"."cashbox_history",
         "finance_schema"."cashboxes" RESTART IDENTITY CASCADE`,
    );
  };

  /** Kod yaratadigan kassalar to'plami (foydalanuvchi / menejer yaratishda). */
  const EXPECTED = () =>
    [
      `couriers:${ids.courier}`,
      `couriers:${ids.courierInactive}`,
      `markets:${ids.market}`,
      `markets:${ids.market2}`,
      `branch:${ids.regional}`,
    ].sort();

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);

    db = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'finance_schema',
      entities: [Cashbox, CashboxHistory, Shift, FinancialBalanceHistory],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA "finance_schema"');
    await db.synchronize();

    // Baseline (1713300000000 / 1713400000000) shakli — migratsiya o'qiydigan ustunlar.
    await db.query('CREATE SCHEMA "identity_schema"');
    await db.query(
      `CREATE TYPE "identity_schema"."admins_role_enum" AS ENUM
         ('superadmin','admin','courier','registrator','market','customer',
          'operator','market_operator','manager','branch','investor','logist')`,
    );
    await db.query(`
      CREATE TABLE "identity_schema"."admins" (
        "id" BIGSERIAL PRIMARY KEY,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" varchar NOT NULL,
        "role" "identity_schema"."admins_role_enum" NOT NULL DEFAULT 'admin'
      )
    `);
    await db.query('CREATE SCHEMA "branch_schema"');
    await db.query(
      `CREATE TYPE "branch_schema"."branches_type_enum" AS ENUM ('HQ', 'PICKUP', 'REGIONAL', 'HYBRID')`,
    );
    await db.query(
      `CREATE TYPE "branch_schema"."branch_users_role_enum" AS ENUM ('MANAGER', 'REGISTRATOR', 'COURIER')`,
    );
    await db.query(`
      CREATE TABLE "branch_schema"."branches" (
        "id" BIGSERIAL PRIMARY KEY,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" varchar NOT NULL,
        "type" "branch_schema"."branches_type_enum" NOT NULL DEFAULT 'PICKUP'
      )
    `);
    await db.query(`
      CREATE TABLE "branch_schema"."branch_users" (
        "id" BIGSERIAL PRIMARY KEY,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "branch_id" bigint NOT NULL,
        "user_id" bigint NOT NULL,
        "role" "branch_schema"."branch_users_role_enum" NOT NULL DEFAULT 'REGISTRATOR'
      )
    `);

    await addUser('superadmin', 'superadmin');
    await addUser('courier', 'courier');
    await addUser('courierInactive', 'courier');
    await addUser('courierDeleted', 'courier', true);
    await addUser('market', 'market');
    await addUser('market2', 'market');
    await addUser('marketDeleted', 'market', true);
    await addUser('operator', 'market_operator');
    await addUser('registrator', 'registrator');
    await addUser('manager', 'manager');
    await addUser('manager2', 'manager');
    await addBranch('hq', 'HQ');
    await addBranch('regional', 'REGIONAL');
    await addBranch('noManager', 'REGIONAL');
    await addBranch('deletedBranch', 'REGIONAL', true);
    await addBranch('formerManager', 'HYBRID');
    await addMember('regional', 'manager', 'MANAGER');
    await addMember('regional', 'courier', 'COURIER');
    // HQ'da menejer bo'lmaydi (HQ_MANAGER_FORBIDDEN) — bo'lsa ham kassa yo'q.
    await addMember('hq', 'manager2', 'MANAGER');
    await addMember('hq', 'registrator', 'REGISTRATOR');
    await addMember('noManager', 'courierInactive', 'COURIER');
    await addMember('deletedBranch', 'manager2', 'MANAGER');
    await addMember('formerManager', 'manager2', 'MANAGER', true);

    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      activityLog as never,
      { send: jest.fn(() => of({ statusCode: 200 })) } as never,
      { send: jest.fn() } as never,
      { send: jest.fn(() => of({ statusCode: 200, data: null })) } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  it('rol → kassa turi identity va enum bilan bir xil', () => {
    expect(USER_CASHBOX_TYPE_BY_ROLE).toEqual({
      [Roles.COURIER]: Cashbox_type.FOR_COURIER,
      [Roles.MARKET]: Cashbox_type.FOR_MARKET,
    });
    expect(BRANCH_CASHBOX_TYPE).toBe(Cashbox_type.BRANCH);
  });

  it("kassalar bor — hech narsa o'zgarmaydi (balansga tegilmaydi)", async () => {
    await addCashbox('0', 'main', 900_000);
    await addCashbox(ids.courier, 'couriers', 120_000);
    await addCashbox(ids.courierInactive, 'couriers');
    await addCashbox(ids.market, 'markets', -50_000);
    await addCashbox(ids.market2, 'markets');
    await addCashbox(ids.regional, 'branch', 300_000);
    const before = await cashboxes();

    await runRestore();

    expect(await cashboxes()).toEqual(before);
  });

  it('prod holati: kassalar o`chib ketgan — kuryer, market va menejerli filial kassasi 0 bilan qaytadi, sotuv oyog`i ishlaydi', async () => {
    await wipeCashboxes();
    const missing = await rpcError(
      finance.findCashboxByUser({
        user_id: ids.market,
        cashbox_type: Cashbox_type.FOR_MARKET,
      }),
    );
    expect(missing).toMatchObject({
      statusCode: 404,
      message: 'Kassa topilmadi',
    });
    const leg = {
      user_id: ids.market,
      cashbox_type: Cashbox_type.FOR_MARKET,
      amount: 50_000,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.SELL,
      source_id: '9001',
    };
    expect(await rpcError(finance.updateBalance(leg))).toMatchObject({
      statusCode: 404,
    });

    await runRestore();

    // O'chirilgan foydalanuvchi / filial, HQ, menejersiz filial, o'chirilgan
    // a'zolik, boshqa rollar va MAIN — kassasiz (MAIN'ni finance o'zi yaratadi).
    expect(await live()).toEqual(EXPECTED());
    expect((await cashboxes()).every((c) => c.balance === 0)).toBe(true);

    for (const [userId, type] of [
      [ids.courier, Cashbox_type.FOR_COURIER],
      [ids.market, Cashbox_type.FOR_MARKET],
      [ids.regional, Cashbox_type.BRANCH],
    ] as const) {
      const found = (await finance.findCashboxByUser({
        user_id: userId,
        cashbox_type: type,
      })) as { statusCode: number; data: { balance: number } };
      expect(found.statusCode).toBe(200);
      expect(found.data.balance).toBe(0);
    }

    const applied = (await finance.updateBalance(leg)) as {
      statusCode: number;
    };
    expect(applied.statusCode).toBe(200);
    const market = (await cashboxes()).find(
      (c) => c.user_id === ids.market && c.type === 'markets',
    );
    expect(market?.balance).toBe(50_000);
  });

  it('qayta yurgizish xavfsiz — dublikat kassa yaratilmaydi', async () => {
    const before = await cashboxes();
    await runRestore();
    await runRestore();
    expect(await cashboxes()).toEqual(before);
  });

  it("qisman yo'qolgan — faqat yo'q kassalar qo'shiladi, borlariga tegilmaydi", async () => {
    await wipeCashboxes();
    await addCashbox(ids.courier, 'couriers', 75_000);
    await addCashbox(ids.regional, 'branch', 10_000);

    await runRestore();

    expect(await live()).toEqual(EXPECTED());
    const rows = await cashboxes();
    expect(
      rows.find((c) => c.user_id === ids.courier && c.type === 'couriers')
        ?.balance,
    ).toBe(75_000);
    expect(
      rows.find((c) => c.user_id === ids.regional && c.type === 'branch')
        ?.balance,
    ).toBe(10_000);
  });

  it("qo'lda o'chirilgan (is_deleted) kassa tiriltirilmaydi va yangisi yaratilmaydi", async () => {
    await wipeCashboxes();
    await addCashbox(ids.market2, 'markets', 0, true);
    await addCashbox(ids.regional, 'branch', 0, true);

    await runRestore();

    const rows = await cashboxes();
    expect(
      rows.filter((c) => c.user_id === ids.market2 && c.type === 'markets'),
    ).toEqual([expect.objectContaining({ is_deleted: true })]);
    expect(
      rows.filter((c) => c.user_id === ids.regional && c.type === 'branch'),
    ).toEqual([expect.objectContaining({ is_deleted: true })]);
    expect(await live()).toEqual(
      [
        `couriers:${ids.courier}`,
        `couriers:${ids.courierInactive}`,
        `markets:${ids.market}`,
      ].sort(),
    );
  });

  it("jadval(lar) yo'q muhitda xatosiz o'tadi", async () => {
    await wipeCashboxes();
    await db.query(`DROP SCHEMA "identity_schema" CASCADE`);
    await runRestore();
    // identity yo'q — faqat filial qadami.
    expect(await live()).toEqual([`branch:${ids.regional}`]);

    await db.query(`DROP SCHEMA "branch_schema" CASCADE`);
    await expect(runRestore()).resolves.toBeUndefined();
    await db.query(`DROP SCHEMA "finance_schema" CASCADE`);
    await expect(runRestore()).resolves.toBeUndefined();
  });
});
