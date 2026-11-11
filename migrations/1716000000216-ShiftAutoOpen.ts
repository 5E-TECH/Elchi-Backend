import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * «Kun tartibi» (ega 2026-11-11) — smenani jadval bo'yicha AVTOMATIK OCHISH.
 *
 * Tizim ochgan smenaning ochuvchi xodimi yo'q:
 *  - `shifts.opened_by` NULL bo'la oladi (faqat tizim smenasida);
 *  - `shifts.opened_by_system` — `closed_by_system` (migratsiya 167) juftligi;
 *  - CHECK: `opened_by` bor YOKI `opened_by_system = true` — xodimsiz qo'lda
 *    ochilgan smena paydo bo'lmasin.
 * `IDX_SHIFT_OPENED_BY_OPEN_UNIQUE` (bitta xodim — bitta ochiq smena) NULL
 * qiymatlarni solishtirmaydi, ya'ni bir nechta kassadagi tizim smenalari
 * unga to'qnashmaydi; «bitta kassa — bitta ochiq smena» kodda kassa qatori
 * qulfi bilan saqlanadi (`openShift` / `autoOpenShift`).
 *
 * `shift_schedule_claims.shift_id` — NULL bo'la oladi: avtomatik ochish va
 * «smena vaqtida ochilmadi» kalitlari (`auto_open:<kassa>:<slot>`,
 * `late_open:<kassa>:<slot>`) smena yaratilishidan OLDIN olinadi.
 *
 * Mavjud qatorlar o'zgarmaydi (hamma eski smenada `opened_by` bor,
 * `opened_by_system` sukut `false`). `IF NOT EXISTS` — qayta ishga tushirish
 * xavfsiz.
 */
export class ShiftAutoOpen1716000000216 implements MigrationInterface {
  name = 'ShiftAutoOpen1716000000216';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
      ADD COLUMN IF NOT EXISTS "opened_by_system" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
      ALTER COLUMN "opened_by" DROP NOT NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_SHIFT_OPENED_BY_OR_SYSTEM'
        ) THEN
          ALTER TABLE "finance_schema"."shifts"
          ADD CONSTRAINT "CHK_SHIFT_OPENED_BY_OR_SYSTEM"
          CHECK ("opened_by" IS NOT NULL OR "opened_by_system" = true);
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_schedule_claims"
      ALTER COLUMN "shift_id" DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Tizim smenalari va kassa kalitlari xodimsiz — NOT NULL ga qaytishdan
    // oldin o'chirilmaydi, faqat belgi qo'yiladi (0 — «tizim»).
    await queryRunner.query(`
      DELETE FROM "finance_schema"."shift_schedule_claims"
      WHERE "shift_id" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_schedule_claims"
      ALTER COLUMN "shift_id" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
      DROP CONSTRAINT IF EXISTS "CHK_SHIFT_OPENED_BY_OR_SYSTEM"
    `);
    await queryRunner.query(`
      UPDATE "finance_schema"."shifts" SET "opened_by" = 0
      WHERE "opened_by" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
      ALTER COLUMN "opened_by" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
      DROP COLUMN IF EXISTS "opened_by_system"
    `);
  }
}
