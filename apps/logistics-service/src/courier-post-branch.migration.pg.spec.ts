import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Post_status } from '@app/common';
import { CourierPostBranch1716000000202 } from '../../../migrations/1716000000202-CourierPostBranch';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';

/**
 * Eski pochtalar (ega qarori 4) — migratsiya 202 haqiqiy Postgres'da
 * (LOGISTICS_POST_LIST_PG_TEST_URI — faqat lokal *_test baza; bo'lmasa skip).
 * Migratsiya `logistics_schema` / `branch_schema` ga qattiq bog'langan, shu
 * bois o'z vaqtinchalik bazasini yaratadi va oxirida o'chiradi.
 *
 *  • filialsiz QABUL QILINGAN kuryer pochtasi — faqat ANIQ filial: hamma
 *    qatorlari bitta filialda bo'lgan kuryer — o'sha filial (eski va yangi
 *    pochtalar); aks holda yagona faol COURIER qatori pochtadan OLDIN beri
 *    o'zgarmagan bo'lsa — o'sha filial; qolgani NULL (A → B dan oldingi
 *    pochta, A → B → A tiklashida B davri, ikki faol qator, roli
 *    almashgan qator, ko'p filialli o'chirilgan kuryer);
 *  • A → B → A (eski qator tiklanadi, `createdAt` eskiligicha) — hech qachon
 *    B emas;
 *  • yo'ldagi (`sent`) kuryer pochtasi, `branch_id` bor, kuryersiz ('0'),
 *    `new` / bekor pochtalar va COURIER bo'lmagan foydalanuvchi pochtasi —
 *    tegilmaydi;
 *  • qayta yurgizish xatosiz va hech narsani o'zgartirmaydi.
 */
const uri = process.env.LOGISTICS_POST_LIST_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'migratsiya 202 — kuryer pochtasi kuryer filialiga (haqiqiy Postgres)',
  () => {
    const dbName = `spec_courier_post_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new CourierPostBranch1716000000202();

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

    const insertPost = async (row: {
      courier_id: string;
      branch_id: string | null;
      status: Post_status;
      /** Pochta yaratilgan payt — `now()` dan necha kun oldin. */
      daysAgo?: number;
    }): Promise<string> => {
      const { daysAgo, ...fields } = row;
      const repo = db.getRepository(Post);
      const saved = await repo.save(
        repo.create({
          ...fields,
          order_quantity: 1,
          post_total_price: 0,
          qr_code_token: `POST-${randomUUID()}`,
        }),
      );
      if (daysAgo !== undefined) {
        await db.query(
          `UPDATE "logistics_schema"."posts" SET "createdAt" = now() - make_interval(days => $2) WHERE "id" = $1`,
          [saved.id, daysAgo],
        );
      }
      return String(saved.id);
    };

    /**
     * branch_users qatori — branch-service kabi: yaratilganda `updatedAt` =
     * `createdAt`, o'chirish/tiklash/rol almashishi `updatedAt` ni yangilaydi.
     */
    const insertBranchUsers = async (
      rows: Array<{
        user_id: number;
        branch_id: number;
        role?: 'COURIER' | 'MANAGER' | 'REGISTRATOR';
        is_deleted: boolean;
        /** Qator yaratilgan payt — `now()` dan necha kun oldin. */
        createdDaysAgo: number;
        /** Oxirgi o'zgarish — necha kun oldin (bo'lmasa `createdDaysAgo`). */
        updatedDaysAgo?: number;
      }>,
    ): Promise<void> => {
      for (const row of rows) {
        await db.query(
          `INSERT INTO "branch_schema"."branch_users"
             ("user_id", "branch_id", "role", "is_deleted", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4,
                   now() - make_interval(days => $5),
                   now() - make_interval(days => $6))`,
          [
            row.user_id,
            row.branch_id,
            row.role ?? 'COURIER',
            row.is_deleted,
            row.createdDaysAgo,
            row.updatedDaysAgo ?? row.createdDaysAgo,
          ],
        );
      }
    };

    const receivedPost = (courierId: string, daysAgo?: number) =>
      insertPost({
        courier_id: courierId,
        branch_id: null,
        status: Post_status.RECEIVED,
        daysAgo,
      });

    const branchOf = async (id: string): Promise<string | null> => {
      const [row]: Array<{ branch_id: string | null }> = await db.query(
        `SELECT "branch_id"::text AS "branch_id" FROM "logistics_schema"."posts" WHERE "id" = $1`,
        [id],
      );
      return row?.branch_id ?? null;
    };

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(uri as string);
      url.pathname = `/${dbName}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'logistics_schema',
        entities: [Post, Region, District],
        synchronize: false,
      });
      await db.initialize();
      await db.query(`CREATE SCHEMA "logistics_schema"`);
      await db.synchronize();
      // branch_users — baseline migratsiyasidagi (1713300000000) shakl.
      await db.query(`CREATE SCHEMA "branch_schema"`);
      await db.query(
        `CREATE TYPE "branch_schema"."branch_users_role_enum" AS ENUM ('MANAGER', 'REGISTRATOR', 'COURIER')`,
      );
      await db.query(`
        CREATE TABLE "branch_schema"."branch_users" (
          "id" BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "is_deleted" boolean NOT NULL DEFAULT false,
          "branch_id" bigint NOT NULL,
          "user_id" bigint NOT NULL,
          "role" "branch_schema"."branch_users_role_enum" NOT NULL DEFAULT 'REGISTRATOR'
        )
      `);
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it('qabul qilingan filialsiz kuryer pochtalari to`ldiriladi, qolganlari tegilmaydi; qayta yurgizish xavfsiz', async () => {
      await insertBranchUsers([
        // 44: 10 kun oldin filial 20 dan 10 ga ko'chgan (faol — 10)
        {
          user_id: 44,
          branch_id: 20,
          is_deleted: true,
          createdDaysAgo: 30,
          updatedDaysAgo: 10,
        },
        { user_id: 44, branch_id: 10, is_deleted: false, createdDaysAgo: 10 },
        // 45: HQ kuryeri
        { user_id: 45, branch_id: 1, is_deleted: false, createdDaysAgo: 1 },
        // 46: o'chirilgan kuryer, ikki filialda bo'lgan — noaniq
        {
          user_id: 46,
          branch_id: 31,
          is_deleted: true,
          createdDaysAgo: 20,
          updatedDaysAgo: 5,
        },
        {
          user_id: 46,
          branch_id: 30,
          is_deleted: true,
          createdDaysAgo: 5,
          updatedDaysAgo: 2,
        },
        // 77: menejer (kuryer emas)
        {
          user_id: 77,
          branch_id: 10,
          role: 'MANAGER',
          is_deleted: false,
          createdDaysAgo: 0,
        },
      ]);

      // 44 — ko'chishdan keyingi pochta 10 da; undan oldingilari NULL
      // (filial 20 davri ham, biriktiruvdan oldingisi ham — noaniq).
      const received44InOldBranch = await insertPost({
        courier_id: '44',
        branch_id: null,
        status: Post_status.RECEIVED,
        daysAgo: 20,
      });
      const received44InNewBranch = await insertPost({
        courier_id: '44',
        branch_id: null,
        status: Post_status.RECEIVED,
        daysAgo: 5,
      });
      // Biriktiruvlardan oldingi pochta — noaniq (NULL).
      const received44BeforeAny = await insertPost({
        courier_id: '44',
        branch_id: null,
        status: Post_status.RECEIVED,
        daysAgo: 40,
      });
      // Yo'ldagi kuryer pochtasi — filial o'tkazmasiga o'xshamasin.
      const sent44 = await insertPost({
        courier_id: '44',
        branch_id: null,
        status: Post_status.SENT,
      });
      const received45 = await insertPost({
        courier_id: '45',
        branch_id: null,
        status: Post_status.RECEIVED,
      });
      const received46 = await insertPost({
        courier_id: '46',
        branch_id: null,
        status: Post_status.RECEIVED,
      });
      const withBranch = await insertPost({
        courier_id: '44',
        branch_id: '99',
        status: Post_status.RECEIVED,
      });
      const transfer = await insertPost({
        courier_id: '0',
        branch_id: null,
        status: Post_status.RECEIVED,
      });
      const newPost = await insertPost({
        courier_id: '44',
        branch_id: null,
        status: Post_status.NEW,
      });
      const canceled = await insertPost({
        courier_id: '44',
        branch_id: null,
        status: Post_status.CANCELED,
      });
      const manager = await insertPost({
        courier_id: '77',
        branch_id: null,
        status: Post_status.RECEIVED,
      });
      const unknown = await insertPost({
        courier_id: '999',
        branch_id: null,
        status: Post_status.RECEIVED,
      });

      await runUp();

      expect(await branchOf(received44InOldBranch)).toBeNull();
      expect(await branchOf(received44InNewBranch)).toBe('10');
      expect(await branchOf(received44BeforeAny)).toBeNull();
      expect(await branchOf(sent44)).toBeNull();
      expect(await branchOf(received45)).toBe('1');
      expect(await branchOf(received46)).toBeNull();
      expect(await branchOf(withBranch)).toBe('99');
      expect(await branchOf(transfer)).toBeNull();
      expect(await branchOf(newPost)).toBeNull();
      expect(await branchOf(canceled)).toBeNull();
      expect(await branchOf(manager)).toBeNull();
      expect(await branchOf(unknown)).toBeNull();

      // Qayta yurgizish: xatosiz, qiymatlar o'zgarmaydi.
      await db.query(
        `UPDATE "branch_schema"."branch_users" SET "branch_id" = 50 WHERE "user_id" = 44 AND "is_deleted" = false`,
      );
      await runUp();
      expect(await branchOf(received44InNewBranch)).toBe('10');
      expect(await branchOf(received44InOldBranch)).toBeNull();
      expect(await branchOf(sent44)).toBeNull();
    });

    it('bitta filialli kuryer — eski va yangi pochtalar o`sha filialga (o`chirilgan/tiklangan qator ham)', async () => {
      await insertBranchUsers([
        // 60: filial 5 — 30 kun oldin chiqarilgan, 3 kun oldin tiklangan
        {
          user_id: 60,
          branch_id: 5,
          is_deleted: false,
          createdDaysAgo: 50,
          updatedDaysAgo: 3,
        },
        // 65: filial 6 — hozir o'chirilgan (filialsiz kuryer)
        {
          user_id: 65,
          branch_id: 6,
          is_deleted: true,
          createdDaysAgo: 20,
          updatedDaysAgo: 10,
        },
      ]);
      const before60 = await receivedPost('60', 60);
      const old60 = await receivedPost('60', 45);
      const gap60 = await receivedPost('60', 20);
      const new60 = await receivedPost('60', 1);
      const old65 = await receivedPost('65', 15);
      const orphan65 = await receivedPost('65', 2);

      await runUp();

      expect(await branchOf(before60)).toBe('5');
      expect(await branchOf(old60)).toBe('5');
      expect(await branchOf(gap60)).toBe('5');
      expect(await branchOf(new60)).toBe('5');
      expect(await branchOf(old65)).toBe('6');
      expect(await branchOf(orphan65)).toBe('6');
    });

    it('A → B → A (eski qator tiklangan, createdAt eski) — tiklashdan keyingi pochta A, hech qachon B emas', async () => {
      await insertBranchUsers([
        // R_A: 30 kun oldin yaratilgan, 15 kun oldin o'chirilib (B ga
        // o'tish), 5 kun oldin tiklangan — oxirgi o'zgarish 5 kun oldin.
        {
          user_id: 61,
          branch_id: 7,
          is_deleted: false,
          createdDaysAgo: 30,
          updatedDaysAgo: 5,
        },
        // R_B: 15 kun oldin yaratilgan, 5 kun oldin o'chirilgan.
        {
          user_id: 61,
          branch_id: 8,
          is_deleted: true,
          createdDaysAgo: 15,
          updatedDaysAgo: 5,
        },
      ]);
      const firstA = await receivedPost('61', 20);
      const duringB = await receivedPost('61', 10);
      const afterRevival = await receivedPost('61', 2);

      await runUp();

      // Eski qoida (eng oxirgi `createdAt <= pochta`) bu yerda B (8) berardi.
      expect(await branchOf(afterRevival)).toBe('7');
      expect(await branchOf(duringB)).toBeNull();
      expect(await branchOf(firstA)).toBeNull();
    });

    it('ikki faol qator yoki roli almashgan (COURIER → MANAGER) qator — noaniq, NULL', async () => {
      await insertBranchUsers([
        // 62: ikki faol COURIER qatori
        { user_id: 62, branch_id: 11, is_deleted: false, createdDaysAgo: 20 },
        { user_id: 62, branch_id: 12, is_deleted: false, createdDaysAgo: 10 },
        // 63: filial 13 da kuryer edi → 14 ga o'tdi → chiqarildi → menejer
        // sifatida 13 ga biriktirildi (eski qator MANAGER roli bilan tiklandi).
        {
          user_id: 63,
          branch_id: 13,
          role: 'MANAGER',
          is_deleted: false,
          createdDaysAgo: 30,
          updatedDaysAgo: 5,
        },
        {
          user_id: 63,
          branch_id: 14,
          is_deleted: true,
          createdDaysAgo: 20,
          updatedDaysAgo: 6,
        },
      ]);
      const twoActive = await receivedPost('62', 5);
      const twoActiveOld = await receivedPost('62', 15);
      const courierIn13 = await receivedPost('63', 25);
      const courierIn14 = await receivedPost('63', 15);
      const asManager = await receivedPost('63', 2);

      await runUp();

      expect(await branchOf(twoActive)).toBeNull();
      expect(await branchOf(twoActiveOld)).toBeNull();
      // Faqat COURIER qatorlari hisoblansa — 14 (noto'g'ri) bo'lardi.
      expect(await branchOf(courierIn13)).toBeNull();
      expect(await branchOf(courierIn14)).toBeNull();
      expect(await branchOf(asManager)).toBeNull();
    });

    it('down() xatosiz (ataylab hech narsa qilmaydi)', async () => {
      await expect(migration.down()).resolves.toBeUndefined();
    });
  },
);
