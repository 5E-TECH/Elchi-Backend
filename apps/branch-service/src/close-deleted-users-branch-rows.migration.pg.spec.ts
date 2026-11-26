import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BranchUserRole } from '@app/common';
import { CloseDeletedUsersBranchRows1716000000252 } from '../../../migrations/1716000000252-CloseDeletedUsersBranchRows';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';

/**
 * (revMyIKg, TC5) Migratsiya 252 — o'chirilgan foydalanuvchilarning FAOL
 * branch_users qatorlarini yopish, HAQIQIY Postgres.
 *
 * Faqat egasi `identity_schema.admins` da `is_deleted = true` bo'lgan faol
 * qatorlar yopiladi (har qanday rol); faol va nofaol (bloklangan) xodimlar,
 * `admins` da yo'q user_id li qatorlar va allaqachon yopilganlar tegilmaydi.
 * Qayta yurgizish hech narsa o'zgartirmaydi.
 *
 * O'z vaqtinchalik bazasi (oxirida o'chiriladi); `BRANCH_PG_TEST_URI` faqat
 * ulanish uchun (faqat lokal xost).
 */
const pgUri = process.env.BRANCH_PG_TEST_URI;
const localHost = (() => {
  if (!pgUri) return false;
  return ['127.0.0.1', 'localhost'].includes(new URL(pgUri).hostname);
})();
const describePg = localHost ? describe : describe.skip;

/** Seed qatorlarining eski `updatedAt` i — yopilgan qator uni yangilaydi. */
const OLD_UPDATED_AT = '2026-01-01T00:00:00.000Z';

type BranchUserRow = {
  id: string;
  branch_id: string;
  user_id: string;
  role: BranchUserRole;
  is_deleted: boolean;
  updated: string;
};

describePg(
  'Migratsiya 252 — o‘chirilgan userlarning filial qatorlarini yopish',
  () => {
    const dbName = `spec_closedbu_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new CloseDeletedUsersBranchRows1716000000252();

    const dbUrl = () => {
      const url = new URL(pgUri!);
      url.pathname = `/${dbName}`;
      return url.toString();
    };

    /** TypeORM kabi: bitta tranzaksiyada. */
    const runUp = async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await migration.up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    };

    const rows = () =>
      db.query<BranchUserRow[]>(
        `SELECT "id"::text AS id, "branch_id"::text AS branch_id,
              "user_id"::text AS user_id, "role"::text AS role, "is_deleted",
              to_char("updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated
         FROM "branch_schema"."branch_users"
        ORDER BY "id"`,
      );
    const rowById = async (id: string) => {
      const row = (await rows()).find((r) => r.id === id);
      if (!row) throw new Error(`branch_users #${id} yo'q`);
      return row;
    };

    const insertBranch = async (name: string, code: string) => {
      const [saved] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "branch_schema"."branches" ("name", "type", "code")
       VALUES ($1, 'REGIONAL', $2) RETURNING "id"::text AS id`,
        [name, code],
      );
      return saved.id;
    };

    /** identity `admins` qatori: o'chirilgan user — `status = inactive` ham. */
    const insertUser = async (
      role: string,
      state: 'active' | 'inactive' | 'deleted',
    ) => {
      const [saved] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "identity_schema"."admins" ("name", "role", "status", "is_deleted")
       VALUES ($1, $2, $3, $4) RETURNING "id"::text AS id`,
        [
          `${role} ${state}`,
          role,
          state === 'active' ? 'active' : 'inactive',
          state === 'deleted',
        ],
      );
      return saved.id;
    };

    const insertBranchUser = async (
      branchId: string,
      userId: string,
      role: BranchUserRole,
      isDeleted = false,
    ) => {
      const [saved] = await db.query<Array<{ id: string }>>(
        `INSERT INTO "branch_schema"."branch_users"
         ("branch_id", "user_id", "role", "is_deleted", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING "id"::text AS id`,
        [branchId, userId, role, isDeleted, OLD_UPDATED_AT],
      );
      return saved.id;
    };

    /** branch-service filial guard'i bilan aynan bir xil sanoq (nofaol qilish / tur / hudud). */
    const activeCouriers = (branchId: string) =>
      db.getRepository(BranchUser).count({
        where: {
          branch_id: branchId,
          role: BranchUserRole.COURIER,
          isDeleted: false,
        },
      });
    /** deleteBranch guard'i bilan bir xil sanoq («N ta faol xodim»). */
    const activeStaff = (branchId: string) =>
      db.getRepository(BranchUser).count({
        where: { branch_id: branchId, isDeleted: false },
      });

    let ids: {
      emptyBranch: string;
      staffedBranch: string;
      deletedCourierRow: string;
      deletedManagerRow: string;
      deletedRegistratorRow: string;
      activeCourierRow: string;
      inactiveCourierRow: string;
      activeManagerRow: string;
      alreadyClosedRow: string;
      orphanRow: string;
    };

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);

      db = new DataSource({
        type: 'postgres',
        url: dbUrl(),
        schema: 'branch_schema',
        entities: [Branch, BranchUser, BranchConfig],
        synchronize: false,
      });
      await db.initialize();
      await db.query('CREATE SCHEMA "branch_schema"');
      await db.synchronize();
      // Baseline (1713400000000) shakli — migratsiya o'qiydigan ustunlar
      // ("id" bigint, "is_deleted") + rol/status (faqat seed aniqligi uchun).
      await db.query('CREATE SCHEMA "identity_schema"');
      await db.query(`
      CREATE TABLE "identity_schema"."admins" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying(100) NOT NULL,
        "role" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'active'
      )
    `);

      // Filial A: faqat «Noma'lum» xodimlar (o'chirilgan kuryer/menejer/registrator).
      const emptyBranch = await insertBranch('Bo‘shab qoladigan filial', 'R-A');
      // Filial B: tirik xodimlar + boshqa holatlar.
      const staffedBranch = await insertBranch('Xodimli filial', 'R-B');

      const deletedCourier = await insertUser('courier', 'deleted');
      const deletedManager = await insertUser('manager', 'deleted');
      const deletedRegistrator = await insertUser('registrator', 'deleted');
      const activeCourier = await insertUser('courier', 'active');
      const inactiveCourier = await insertUser('courier', 'inactive');
      const activeManager = await insertUser('manager', 'active');
      const deletedCourierClosed = await insertUser('courier', 'deleted');

      ids = {
        emptyBranch,
        staffedBranch,
        deletedCourierRow: await insertBranchUser(
          emptyBranch,
          deletedCourier,
          BranchUserRole.COURIER,
        ),
        deletedManagerRow: await insertBranchUser(
          emptyBranch,
          deletedManager,
          BranchUserRole.MANAGER,
        ),
        deletedRegistratorRow: await insertBranchUser(
          emptyBranch,
          deletedRegistrator,
          BranchUserRole.REGISTRATOR,
        ),
        activeCourierRow: await insertBranchUser(
          staffedBranch,
          activeCourier,
          BranchUserRole.COURIER,
        ),
        inactiveCourierRow: await insertBranchUser(
          staffedBranch,
          inactiveCourier,
          BranchUserRole.COURIER,
        ),
        activeManagerRow: await insertBranchUser(
          staffedBranch,
          activeManager,
          BranchUserRole.MANAGER,
        ),
        // fix3b dan keyin o'chirilgan: qatori allaqachon yopilgan.
        alreadyClosedRow: await insertBranchUser(
          staffedBranch,
          deletedCourierClosed,
          BranchUserRole.COURIER,
          true,
        ),
        // admins da umuman yo'q user — o'chirilgan deb bilib bo'lmaydi.
        orphanRow: await insertBranchUser(
          staffedBranch,
          '987654321',
          BranchUserRole.COURIER,
        ),
      };
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it("oldin: filial A da 3 ta «Noma'lum» xodim — guard'lar 409/400 berardi", async () => {
      expect(await activeCouriers(ids.emptyBranch)).toBe(1);
      expect(await activeStaff(ids.emptyBranch)).toBe(3);
    });

    it("faqat o'chirilgan userlarning faol qatorlari yopiladi (har qanday rol), updatedAt yangilanadi", async () => {
      const before = await rows();
      const startedAt = Date.now();

      await runUp();

      const after = await rows();
      // Qator o'chirilmaydi va qo'shilmaydi — faqat soft-close.
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));

      for (const id of [
        ids.deletedCourierRow,
        ids.deletedManagerRow,
        ids.deletedRegistratorRow,
      ]) {
        const row = await rowById(id);
        expect(row.is_deleted).toBe(true);
        expect(Date.parse(row.updated)).toBeGreaterThanOrEqual(
          startedAt - 60_000,
        );
        expect(row.updated).not.toBe(OLD_UPDATED_AT);
      }

      // Faol, nofaol (bloklangan) xodim, allaqachon yopilgan va admins da yo'q
      // user_id li qatorlar — aynan avvalgidek (updatedAt ham).
      for (const id of [
        ids.activeCourierRow,
        ids.inactiveCourierRow,
        ids.activeManagerRow,
        ids.alreadyClosedRow,
        ids.orphanRow,
      ]) {
        expect(await rowById(id)).toEqual(before.find((r) => r.id === id));
      }
    });

    it("TC2: filial A da faol kuryer/xodim qolmadi; filial B sanog'i o'zgarmadi", async () => {
      expect(await activeCouriers(ids.emptyBranch)).toBe(0);
      expect(await activeStaff(ids.emptyBranch)).toBe(0);
      // B: faol kuryer + nofaol kuryer + admins da yo'q (orphan) = 3; + menejer.
      expect(await activeCouriers(ids.staffedBranch)).toBe(3);
      expect(await activeStaff(ids.staffedBranch)).toBe(4);
    });

    it('identity va filial jadvallariga boshqa yozuv yo‘q', async () => {
      const users = await db.query<Array<{ deleted: number; total: number }>>(
        `SELECT count(*) FILTER (WHERE "is_deleted")::int AS deleted,
              count(*)::int AS total
         FROM "identity_schema"."admins"`,
      );
      expect(users[0]).toEqual({ deleted: 4, total: 7 });
      const branches = await db.query<
        Array<{ code: string; is_deleted: boolean }>
      >(
        `SELECT "code", "is_deleted" FROM "branch_schema"."branches" ORDER BY "id"`,
      );
      expect(branches).toEqual([
        { code: 'R-A', is_deleted: false },
        { code: 'R-B', is_deleted: false },
      ]);
    });

    it('qayta yurgizish xavfsiz — hech narsa o‘zgarmaydi', async () => {
      const before = await rows();
      await runUp();
      await runUp();
      expect(await rows()).toEqual(before);
    });

    it("keyin o'chirilgan user — keyingi yurgizishda uning qatori ham yopiladi", async () => {
      const [{ user_id: userId }] = await db.query<Array<{ user_id: string }>>(
        `SELECT "user_id"::text AS user_id FROM "branch_schema"."branch_users" WHERE "id" = $1`,
        [ids.activeCourierRow],
      );
      await db.query(
        `UPDATE "identity_schema"."admins" SET "is_deleted" = true, "status" = 'inactive' WHERE "id" = $1`,
        [userId],
      );

      await runUp();

      expect((await rowById(ids.activeCourierRow)).is_deleted).toBe(true);
      expect((await rowById(ids.inactiveCourierRow)).is_deleted).toBe(false);
      expect((await rowById(ids.orphanRow)).is_deleted).toBe(false);
    });

    it("jadval(lar) yo'q muhitda xatosiz o'tadi", async () => {
      await db.query(`DROP SCHEMA "identity_schema" CASCADE`);
      await expect(runUp()).resolves.toBeUndefined();
      await db.query(`DROP SCHEMA "branch_schema" CASCADE`);
      await expect(runUp()).resolves.toBeUndefined();
    });
  },
);
