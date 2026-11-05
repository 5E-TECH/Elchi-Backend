import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AFZaUUi5: qo'shimcha xarajat so'roviga market javob bermasa — 24 soatda
 * avtomatik tasdiq (env `EXTRA_COST_AUTO_APPROVE_MINUTES` bo'sh bo'lsa ham).
 *
 *  1. `auto_approve_from` — avtomatik tasdiq muddati shu vaqtdan sanaladi.
 *     Shu paytda OCHIQ turgan so'rovlar uchun — hozirgi vaqt (avtomatik
 *     tasdiq yoqilgan payt): ilgari muddat bo'lmagan, 24 soatdan eski so'rovlar
 *     birinchi daqiqada birdan tasdiqlanib ketmasin, har biriga 10 daqiqa
 *     oldin eslatma ham borsin (`reminder_sent_at` tozalanadi). Yopilgan
 *     so'rovlar — `createdAt` (faqat ma'lumot uchun). Yangi so'rovlar — DB
 *     sukuti `now()`, ya'ni yaratilgan vaqt. `createdAt` ga TEGILMAYDI: tasdiq
 *     darvozasi (so'rovdan keyin holat o'zgarganmi) undan sanaladi.
 *  2. `auto_attempts`, `auto_retry_at` — avtomatik urinish infratuzilma xatosi
 *     bilan tugasa, keyingisi kechiktiriladi (har daqiqa qayta urinilmaydi).
 *  3. Skaner uchun partial indeks.
 *
 * Nechta ochiq so'rov yoqilgan paytdan sanalishi db-prepare logiga yoziladi.
 * Qayta yurgizish hech narsani o'zgartirmaydi. Jadval yo'q — hech narsa
 * qilinmaydi. down(): indeks va ustunlar olib tashlanadi.
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

    const count = (rows: unknown): number =>
      Array.isArray(rows) && Array.isArray(rows[0])
        ? rows[0].length
        : Array.isArray(rows)
          ? rows.length
          : 0;

    // 1. Ochiq so'rovlar — muddat yoqilgan paytdan.
    const anchored = await queryRunner.query(`
      UPDATE "order_schema"."order_extra_cost_approvals"
         SET "auto_approve_from" = now(),
             "reminder_sent_at" = NULL
       WHERE "auto_approve_from" IS NULL
         AND "status" = 'pending'
         AND "is_deleted" = false
      RETURNING "id"
    `);
    await queryRunner.query(`
      UPDATE "order_schema"."order_extra_cost_approvals"
         SET "auto_approve_from" = "createdAt"
       WHERE "auto_approve_from" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
        ALTER COLUMN "auto_approve_from" SET DEFAULT now(),
        ALTER COLUMN "auto_approve_from" SET NOT NULL
    `);

    // 3. Skaner: ochiq so'rovlar muddati bo'yicha.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_EXTRA_COST_PENDING_AUTO_FROM"
        ON "order_schema"."order_extra_cost_approvals" ("auto_approve_from")
        WHERE "status" = 'pending' AND "is_deleted" = false
    `);

    console.log(
      `[migration 208] extra-cost: avtomatik tasdiq muddati yoqilgan paytdan sanaladigan ochiq so'rovlar ${count(anchored)}`,
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
