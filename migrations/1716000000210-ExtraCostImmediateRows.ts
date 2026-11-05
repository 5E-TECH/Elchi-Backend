import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GykuOz8f: «Qo'shimcha xarajatli buyurtmalar» sahifasi (kuryer, filial
 * menejeri, market) — tasdiqsiz yozilgan xarajat ham shu jadvalda.
 *
 *  1. `immediate` — market tasdig'isiz (tasdiq o'chiq market yoki qayta ijro
 *     bo'lmagan har qanday yo'l) darhol yozilgan xarajat. Kod sotish / bekor
 *     qilish / qisman sotish tranzaksiyasida `status = 'approved'`,
 *     `immediate = true` qatorini yozadi; orqaga qaytarishda u boshqa
 *     tasdiqlanganlar kabi `reversed` bo'ladi.
 *  2. Kuryer va menejer ro'yxati uchun indekslar: `requested_by_user_id` va
 *     `requester_branch_id` bo'yicha (`createdAt` tartibida).
 *  3. Eski ma'lumot: o'chirilmagan, `extra_cost > 0` va `approved` so'rovi
 *     yo'q har bir buyurtmaga bitta `immediate` qator. Kim / qachon / qaysi
 *     amal — `order_tracking` dagi oxirgi «kutilmoqda» → sotildi / to'landi /
 *     qisman / bekor o'tishidan (yozgan id raqam bo'lishi shart; rol kuryer
 *     yoki menejer, boshqasi — kuryer). Filial — yozgan xodimning HOZIRGI
 *     `branch_schema.branch_users` a'zoligi (jadval yo'q — NULL). Isbot —
 *     `orders.proof_files`. Faqat ijro bo'lgan holatdagi buyurtma olinadi;
 *     mos o'tish topilmagan yoki o'tishdan keyin orqaga qaytarilgan (keyin
 *     «kutilmoqda» ga o'tgan yoki «Rollback to …») buyurtma o'tkazib
 *     yuboriladi. Sonlar db-prepare logiga yoziladi.
 *
 * Qayta yurgizish hech narsani o'zgartirmaydi (endi har biriga `approved`
 * qator bor). Jadval yo'q — hech narsa qilinmaydi. down(): `immediate`
 * qatorlar o'chiriladi, indekslar va ustun olib tashlanadi.
 */
export class ExtraCostImmediateRows1716000000210 implements MigrationInterface {
  name = 'ExtraCostImmediateRows1716000000210';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [table] = (await queryRunner.query(
      `SELECT to_regclass('"order_schema"."order_extra_cost_approvals"') IS NOT NULL AS "exists"`,
    )) as Array<{ exists: boolean }>;
    if (!table?.exists) return;

    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
        ADD COLUMN IF NOT EXISTS "immediate" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_EXTRA_COST_REQUESTER_CREATED"
        ON "order_schema"."order_extra_cost_approvals" ("requested_by_user_id", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_EXTRA_COST_BRANCH_CREATED"
        ON "order_schema"."order_extra_cost_approvals" ("requester_branch_id", "createdAt")
    `);

    const [deps] = (await queryRunner.query(`
      SELECT to_regclass('"order_schema"."orders"') IS NOT NULL AS "orders",
             to_regclass('"order_schema"."order_tracking"') IS NOT NULL AS "tracking",
             to_regclass('"branch_schema"."branch_users"') IS NOT NULL AS "branch_users"
    `)) as Array<{ orders: boolean; tracking: boolean; branch_users: boolean }>;
    if (!deps?.orders || !deps?.tracking) {
      console.log(
        `[migration 210] extra-cost: orders / order_tracking jadvali yo'q — eski xarajatlar ko'chirilmadi`,
      );
      return;
    }
    // Yozgan xodimning hozirgi filiali (bitta faol a'zolik — 1714000000000).
    const branchOf = deps.branch_users
      ? `(SELECT bu."branch_id"
            FROM "branch_schema"."branch_users" bu
           WHERE bu."user_id" = s."changed_by"::bigint
             AND bu."is_deleted" = false
           ORDER BY bu."createdAt" DESC, bu."id" DESC
           LIMIT 1)`
      : 'NULL::bigint';

    const [result] = (await queryRunner.query(`
      WITH "candidates" AS (
        SELECT o."id", o."market_id", o."extra_cost", o."proof_files"
          FROM "order_schema"."orders" o
         WHERE o."is_deleted" = false
           AND o."extra_cost" > 0
           AND o."market_id" IS NOT NULL
           AND o."status"::text IN ('sold', 'paid', 'partly_paid', 'cancelled', 'cancelled (sent)',
                                    'closed', 'returned_to_market')
           AND NOT EXISTS (
             SELECT 1 FROM "order_schema"."order_extra_cost_approvals" a
              WHERE a."order_id" = o."id"
                AND a."status" = 'approved'
           )
      ),
      "sources" AS (
        SELECT c."id" AS "order_id", c."market_id", c."extra_cost",
               c."proof_files", t."changed_by", t."changed_by_role",
               t."to_status", t."action", t."note", t."created_at"
          FROM "candidates" c
          CROSS JOIN LATERAL (
            SELECT t."changed_by", t."changed_by_role", t."to_status"::text AS "to_status",
                   t."action", t."note", t."created_at"
              FROM "order_schema"."order_tracking" t
             WHERE t."order_id" = c."id"
               AND t."from_status"::text = 'waiting'
               AND t."to_status"::text IN ('sold', 'paid', 'partly_paid', 'cancelled', 'cancelled (sent)')
               -- 154a400d (2026-10-01) gacha rollback extra_cost ni nolga
               -- tushirmasdi: keyin orqaga qaytarilgan ijro hisobga olinmaydi.
               AND NOT EXISTS (
                 SELECT 1 FROM "order_schema"."order_tracking" r
                  WHERE r."order_id" = c."id"
                    AND r."created_at" > t."created_at"
                    AND ((r."to_status"::text = 'waiting'
                          AND r."from_status"::text IS DISTINCT FROM 'waiting')
                         OR r."note" LIKE 'Rollback to %')
               )
             ORDER BY t."created_at" DESC
             LIMIT 1
          ) t
      ),
      "inserted" AS (
        INSERT INTO "order_schema"."order_extra_cost_approvals"
          ("order_id", "market_id", "requested_by_user_id", "requested_by_role",
           "requester_branch_id", "action", "amount", "proof_file_keys",
           "operation_payload", "status", "immediate", "auto_approved",
           "decided_by_user_id", "decided_at", "createdAt", "updatedAt")
        SELECT s."order_id", s."market_id", s."changed_by"::bigint,
               CASE WHEN s."changed_by_role" IN ('courier', 'manager')
                    THEN s."changed_by_role" ELSE 'courier' END,
               ${branchOf},
               CASE WHEN s."to_status" IN ('cancelled', 'cancelled (sent)') THEN 'cancel'
                    WHEN s."action" = 'partly_sold'
                      OR lower(coalesce(s."note", '')) LIKE '%partly%' THEN 'partly_sell'
                    ELSE 'sell' END,
               s."extra_cost",
               CASE WHEN jsonb_typeof(s."proof_files") = 'array'
                    THEN s."proof_files" ELSE '[]'::jsonb END,
               '{"backfill": true}'::jsonb,
               'approved', true, false, NULL,
               s."created_at", s."created_at", s."created_at"
          FROM "sources" s
         WHERE s."changed_by" ~ '^[0-9]+$'
        RETURNING "id"
      )
      SELECT (SELECT count(*) FROM "candidates")::int AS "candidates",
             (SELECT count(*) FROM "inserted")::int AS "inserted"
    `)) as Array<{ candidates: number; inserted: number }>;
    const candidates = Number(result?.candidates ?? 0);
    const inserted = Number(result?.inserted ?? 0);
    console.log(
      `[migration 210] extra-cost: tasdiqsiz yozilgan eski xarajatlar — ${inserted} ta qator qo'shildi, ${candidates - inserted} ta buyurtma o'tkazib yuborildi (mos kuzatuv yozuvi yo'q yoki ijro orqaga qaytarilgan)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [column] = (await queryRunner.query(`
      SELECT 1 AS "exists"
        FROM information_schema.columns
       WHERE table_schema = 'order_schema'
         AND table_name = 'order_extra_cost_approvals'
         AND column_name = 'immediate'
    `)) as Array<{ exists: number }>;
    if (column) {
      await queryRunner.query(
        `DELETE FROM "order_schema"."order_extra_cost_approvals" WHERE "immediate" = true`,
      );
    }
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_EXTRA_COST_BRANCH_CREATED"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_EXTRA_COST_REQUESTER_CREATED"`,
    );
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "order_schema"."order_extra_cost_approvals"
        DROP COLUMN IF EXISTS "immediate"
    `);
  }
}
