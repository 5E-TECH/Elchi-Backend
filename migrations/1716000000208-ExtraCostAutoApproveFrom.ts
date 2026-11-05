import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AFZaUUi5: qo'shimcha xarajat so'roviga market javob bermasa — 24 soatda
 * avtomatik tasdiq (env `EXTRA_COST_AUTO_APPROVE_MINUTES` bo'sh bo'lsa ham).
 *
 *  1. `auto_approve_from` — avtomatik tasdiq muddati shu vaqtdan sanaladi.
 *     Migratsiya uni TO'LDIRMAYDI va sukut qo'ymaydi (NULL): muddat boshini
 *     skaner so'rovni birinchi ko'rganda belgilaydi — muddatdan eski ochiq
 *     so'rov (avtomatik tasdiq yoqilgan paytda ochiq turgan) uchun o'sha payt,
 *     yangisi uchun `createdAt`. Deploy orqaga qaytarilib keyin qayta
 *     chiqarilsa ham «yoqilgan payt» — yangi kod haqiqatan ishlagan payt
 *     (migratsiya yurgan payt emas). `createdAt` ga TEGILMAYDI.
 *  2. `auto_attempts`, `auto_retry_at` — avtomatik urinish infratuzilma xatosi
 *     bilan tugasa, keyingisi kechiktiriladi (har daqiqa qayta urinilmaydi).
 *  3. Skaner uchun partial indeks.
 *
 * Ochiq so'rovlar soni db-prepare logiga yoziladi. Faqat ustun va indeks
 * qo'shiladi — mavjud qatorlar o'zgarmaydi; qayta yurgizish xavfsiz. Jadval
 * yo'q — hech narsa qilinmaydi. down(): indeks va ustunlar olib tashlanadi.
 */
export class ExtraCostAutoApproveFrom1716000000208 implements MigrationInterface {
  name = 'ExtraCostAutoApproveFrom1716000000208';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [table] = (await queryRunner.query(
      `SELECT to_regclass('"order_schema"."order_extra_cost_approvals"') IS NOT NULL AS "exists"`,
    )) as Array<{ exists: boolean }>;
    if (!table?.exists) return;

    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
        ADD COLUMN IF NOT EXISTS "auto_approve_from" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "auto_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "auto_retry_at" timestamptz NULL
    `);

    // Skaner: ochiq so'rovlar muddati bo'yicha.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_EXTRA_COST_PENDING_AUTO_FROM"
        ON "order_schema"."order_extra_cost_approvals" ("auto_approve_from")
        WHERE "status" = 'pending' AND "is_deleted" = false
    `);

    const [open] = (await queryRunner.query(`
      SELECT count(*)::int AS "count"
        FROM "order_schema"."order_extra_cost_approvals"
       WHERE "status" = 'pending' AND "is_deleted" = false
    `)) as Array<{ count: number }>;
    console.log(
      `[migration 208] extra-cost: ochiq so'rovlar ${open?.count ?? 0} — avtomatik tasdiq muddati boshini skaner birinchi tikda belgilaydi`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_EXTRA_COST_PENDING_AUTO_FROM"`,
    );
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "order_schema"."order_extra_cost_approvals"
        DROP COLUMN IF EXISTS "auto_retry_at",
        DROP COLUMN IF EXISTS "auto_attempts",
        DROP COLUMN IF EXISTS "auto_approve_from"
    `);
  }
}
