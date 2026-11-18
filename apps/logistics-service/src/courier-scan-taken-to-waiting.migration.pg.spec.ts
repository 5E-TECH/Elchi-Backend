import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CourierScanTakenToWaiting1716000000240 } from '../../../migrations/1716000000240-CourierScanTakenToWaiting';

/**
 * Migratsiya 240 — COURIER-SCAN (ega, 2026-11-17): skan bilan olingan, hamon
 * `on the road` turgan eski qatorlar → `waiting` + tarix qatori; yo'ldagi
 * buyurtmasi qolmagan SENT kuryer pochtalari → `received` (kuryer filiali
 * bilan). HAQIQIY Postgres, kerakli ustunlargina (o'z vaqtinchalik bazasi,
 * oxirida o'chiriladi); `COURIER_SCAN_PG_TEST_URI` faqat ulanish uchun.
 */
const pgUri = process.env.COURIER_SCAN_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('Migratsiya 240 — skan bilan olingan buyurtmalar WAITING ga', () => {
  const dbName = `spec_cscan_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new CourierScanTakenToWaiting1716000000240();

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const run = async () => {
    const runner = db.createQueryRunner();
    try {
      await migration.up(runner);
    } finally {
      await runner.release();
    }
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    db = new DataSource({ type: 'postgres', url: dbUrl() });
    await db.initialize();
    await db.query(`
      CREATE SCHEMA "order_schema";
      CREATE SCHEMA "logistics_schema";
      CREATE SCHEMA "branch_schema";
      CREATE TYPE "order_schema"."orders_status_enum" AS ENUM
        ('new', 'received', 'on the road', 'waiting', 'sold');
      -- Tarix ustunlari boshqa (va bir-biridan ham farqli) enum turlarida —
      -- migratsiya har ustun turini o'zi topishi shart (ikki enum orasida cast yo'q).
      CREATE TYPE "order_schema"."order_tracking_from_status_enum" AS ENUM
        ('new', 'received', 'on the road', 'waiting', 'sold');
      CREATE TYPE "order_schema"."order_tracking_to_status_enum" AS ENUM
        ('new', 'received', 'on the road', 'waiting', 'sold');
      CREATE TYPE "logistics_schema"."posts_status_enum" AS ENUM
        ('new', 'sent', 'received', 'canceled', 'canceled_received');
      CREATE TABLE "order_schema"."orders" (
        "id" bigint PRIMARY KEY,
        "status" "order_schema"."orders_status_enum" NOT NULL,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "holder_type" varchar(16),
        "holder_courier_id" bigint,
        "courier_id" bigint,
        "last_handover_by" bigint,
        "return_requested" boolean NOT NULL DEFAULT false,
        "post_id" bigint
      );
      CREATE TABLE "order_schema"."order_tracking" (
        "id" serial PRIMARY KEY,
        "order_id" bigint NOT NULL,
        "from_status" "order_schema"."order_tracking_from_status_enum",
        "to_status" "order_schema"."order_tracking_to_status_enum" NOT NULL,
        "changed_by" varchar(64) NOT NULL,
        "changed_by_role" varchar(32) NOT NULL,
        "action" varchar(64),
        "description" text,
        "metadata" jsonb,
        "note" text
      );
      CREATE TABLE "logistics_schema"."posts" (
        "id" bigint PRIMARY KEY,
        "courier_id" bigint,
        "status" "logistics_schema"."posts_status_enum" NOT NULL,
        "branch_id" bigint,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "branch_schema"."branch_users" (
        "id" serial PRIMARY KEY,
        "user_id" bigint NOT NULL,
        "branch_id" bigint NOT NULL,
        "role" varchar(32) NOT NULL,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now() - interval '30 days',
        "updatedAt" timestamptz NOT NULL DEFAULT now() - interval '30 days'
      );
    `);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin?.destroy();
  });

  beforeEach(async () => {
    await db.query(`
      TRUNCATE "order_schema"."orders", "order_schema"."order_tracking",
               "logistics_schema"."posts", "branch_schema"."branch_users";
      INSERT INTO "branch_schema"."branch_users" ("user_id", "branch_id", "role")
      VALUES (44, 10, 'COURIER'), (45, 10, 'COURIER'), (198, 10, 'MANAGER');
      INSERT INTO "logistics_schema"."posts" ("id", "courier_id", "status", "branch_id") VALUES
        (40, 44, 'sent', NULL),  -- faqat skan bilan olingan buyurtma
        (41, 45, 'sent', NULL),  -- menejer jo'natgan, hali yo'lda
        (42, 0, 'sent', 10),     -- HQ → filial o'tkazma pochtasi
        (43, 44, 'sent', NULL);  -- bo'sh kuryer pochtasi
      INSERT INTO "order_schema"."orders"
        ("id", "status", "holder_type", "holder_courier_id", "courier_id",
         "last_handover_by", "return_requested", "post_id") VALUES
        -- skan bilan olingan (kuryerning o'zi topshirgan) — ko'chiriladi
        (101, 'on the road', 'COURIER', 44, 44, 44, false, 40),
        -- menejer biriktirgan (topshiruvchi — menejer) — tegilmaydi
        (102, 'on the road', 'COURIER', 45, 45, 198, false, 41),
        -- «kelmagan» belgili — tegilmaydi
        (103, 'on the road', 'COURIER', 44, 44, 44, true, 43),
        -- o'tkazma pochtasida, kuryersiz — tegilmaydi
        (104, 'on the road', 'BRANCH', NULL, NULL, 1, false, 42),
        -- allaqachon WAITING — tegilmaydi
        (105, 'waiting', 'COURIER', 44, 44, 44, false, 40);
    `);
  });

  const statusOf = async (id: number) =>
    (
      await db.query<Array<{ status: string }>>(
        `SELECT "status"::text AS status FROM "order_schema"."orders" WHERE "id" = $1`,
        [id],
      )
    )[0]?.status;

  const postOf = async (id: number) =>
    (
      await db.query<Array<{ status: string; branch_id: string | null }>>(
        `SELECT "status"::text AS status, "branch_id"::text AS branch_id
           FROM "logistics_schema"."posts" WHERE "id" = $1`,
        [id],
      )
    )[0];

  it('⭐ faqat kuryerning o‘zi skan bilan olgan ON_THE_ROAD qatori WAITING bo‘ladi, tarixda bitta qator', async () => {
    await run();

    expect(await statusOf(101)).toBe('waiting');
    expect(await statusOf(102)).toBe('on the road');
    expect(await statusOf(103)).toBe('on the road');
    expect(await statusOf(104)).toBe('on the road');
    expect(await statusOf(105)).toBe('waiting');

    const tracking = await db.query<
      Array<{
        order_id: string;
        from_status: string;
        to_status: string;
        action: string;
        changed_by: string;
        metadata: Record<string, unknown>;
      }>
    >(
      `SELECT "order_id"::text AS order_id, "from_status"::text AS from_status,
              "to_status"::text AS to_status, "action", "changed_by", "metadata"
         FROM "order_schema"."order_tracking"`,
    );
    expect(tracking).toEqual([
      expect.objectContaining({
        order_id: '101',
        from_status: 'on the road',
        to_status: 'waiting',
        action: 'courier_scan_received',
        changed_by: 'system',
        metadata: expect.objectContaining({
          post_id: '40',
          courier_id: '44',
          source: 'courier_scan_accepts_migration',
        }),
      }),
    ]);
  });

  it('⭐ yo‘ldagisi qolmagan SENT kuryer pochtasi RECEIVED (kuryer filiali bilan); yo‘ldagisi bor va o‘tkazma pochtasi — SENT', async () => {
    await run();

    expect(await postOf(40)).toEqual({ status: 'received', branch_id: '10' });
    // 102 hali yo'lda — pochta ochiq.
    expect(await postOf(41)).toEqual({ status: 'sent', branch_id: null });
    // O'tkazma pochtasi (kuryersiz) — tegilmaydi.
    expect(await postOf(42)).toEqual({ status: 'sent', branch_id: '10' });
    // «Kelmagan» buyurtma hamon yo'lda — pochta ochiq.
    expect(await postOf(43)).toEqual({ status: 'sent', branch_id: null });
  });

  it('qayta yurgizish xatosiz va hech narsa qo‘shmaydi', async () => {
    await run();
    await run();
    const [{ count }] = await db.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM "order_schema"."order_tracking"`,
    );
    expect(count).toBe('1');
  });
});
