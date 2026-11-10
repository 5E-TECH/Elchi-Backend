import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kassa xarajati kategoriyalari — STANDART (default) kategoriyalar qulfi
 * (ega 2026-11-11: «default xarajatlarni o'chirib ham, edit ham qilib
 * bo'lmasin; yangi qo'shilganlarini edit ham, delete ham qilib bo'lsin»).
 *
 *   1. `finance_schema.cashbox_expense_categories.is_default`
 *      (`BOOLEAN NOT NULL DEFAULT false`) — servis bunday qatorni
 *      tahrirlash (`PATCH`) va o'chirishni (`DELETE`) 403 bilan rad etadi.
 *   2. Belgilanadigan qatorlar — migratsiya 129 seed'i (product owner bergan
 *      17 ta kategoriya). Ularni `created_by IS NULL` ajratadi: seed
 *      `created_by` ni yozmaydi, API orqali qo'shilgan har qatorda esa
 *      gateway doim superadmin ID sini (`req.user.sub`) yozadi. Seed'dan
 *      keyin qayta nomlangani ham standart qoladi (nomi emas, kelib chiqishi
 *      hal qiladi); o'chirib bo'lingan seed qatori o'chirilganicha qoladi —
 *      faqat belgi qo'yiladi, `is_deleted` ga tegilmaydi.
 *
 * Boshqa ustun va jadvallarga tegilmaydi, pulga aloqasi yo'q. `lock_timeout`
 * 5 s (jadval kichik, 17 + superadmin qo'shganlari). Qayta ishga tushirish
 * xavfsiz (`IF NOT EXISTS`, UPDATE faqat `false` qatorlarni yozadi).
 *
 * down(): ustun o'chiriladi (qulf yo'qoladi, ma'lumot yo'qolmaydi).
 */
export class CashboxExpenseCategoryIsDefault1716000000214 implements MigrationInterface {
  name = 'CashboxExpenseCategoryIsDefault1716000000214';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
      BEGIN
        IF to_regclass('finance_schema.cashbox_expense_categories') IS NULL THEN
          RETURN;
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);
        ALTER TABLE "finance_schema"."cashbox_expense_categories"
          ADD COLUMN IF NOT EXISTS "is_default" BOOLEAN NOT NULL DEFAULT false;
        UPDATE "finance_schema"."cashbox_expense_categories"
           SET "is_default" = true
         WHERE "created_by" IS NULL
           AND "is_default" = false;
        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('finance_schema.cashbox_expense_categories') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "finance_schema"."cashbox_expense_categories"
          DROP COLUMN IF EXISTS "is_default";
      END $$;
    `);
  }
}
