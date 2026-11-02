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
 *  • filialsiz QABUL QILINGAN kuryer pochtasi — pochta yaratilgan paytdagi
 *    COURIER biriktiruvi filiali (kuryer filial almashtirgan bo'lsa eski
 *    pochtalar eski filialda); undan oldingi pochta — faol biriktiruv;
 *    o'chirilgan kuryer — eng oxirgi biriktiruvi;
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
      await db.query(`
        INSERT INTO "branch_schema"."branch_users"
          ("user_id", "branch_id", "role", "is_deleted", "createdAt")
        VALUES
          -- 44: filial 20 dan 10 ga ko'chgan (faol — 10)
          (44, 20, 'COURIER', true,  now() - interval '30 days'),
          (44, 10, 'COURIER', false, now() - interval '10 days'),
          -- 45: HQ kuryeri
          (45, 1,  'COURIER', false, now() - interval '1 day'),
          -- 46: o'chirilgan kuryer — eng oxirgi biriktiruvi (30)
          (46, 31, 'COURIER', true,  now() - interval '20 days'),
          (46, 30, 'COURIER', true,  now() - interval '5 days'),
          -- 77: menejer (kuryer emas)
          (77, 10, 'MANAGER', false, now())
      `);

      // 44 — filial 20 davridagi pochta 20 da, 10 davridagisi 10 da qoladi.
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
      // Biriktiruvlardan oldingi pochta — faol biriktiruv (10).
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

      expect(await branchOf(received44InOldBranch)).toBe('20');
      expect(await branchOf(received44InNewBranch)).toBe('10');
      expect(await branchOf(received44BeforeAny)).toBe('10');
      expect(await branchOf(sent44)).toBeNull();
      expect(await branchOf(received45)).toBe('1');
      expect(await branchOf(received46)).toBe('30');
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
      expect(await branchOf(received44BeforeAny)).toBe('10');
      expect(await branchOf(sent44)).toBeNull();
    });

    it('down() xatosiz (ataylab hech narsa qilmaydi)', async () => {
      await expect(migration.down()).resolves.toBeUndefined();
    });
  },
);
