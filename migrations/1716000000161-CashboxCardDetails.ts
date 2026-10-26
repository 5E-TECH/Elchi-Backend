import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zv3MLn0a — kassa kartalari / hisob raqamlari tafsilotlari (BeePost
 * `cashbox_card` namunasi). Parallel jadval QURILMAYDI — mavjud
 * `finance_schema.cashbox_cards` kengaytiriladi:
 *
 *   • `kind`         — virtual_card | plastic_card | bank_account (NULL — eski
 *                      kartalar, turi ko'rsatilmagan);
 *   • `bank_name`, `card_network` (Uzcard / Humo / Visa …), `holder_name`,
 *     `note`         — matn, ixtiyoriy;
 *   • `last4`        — FAQAT oxirgi 4 raqam (CHECK `^[0-9]{4}$`). To'liq karta
 *                      (PAN) / hisob raqami SAQLANMAYDI;
 *   • `require_photo_on_shift_close`, `ai_check_enabled` — smena yopishdagi
 *     karta sozlamalari (faqat superadmin o'zgartiradi; AI faqat rasm talab
 *     qilinganda — CHECK).
 *
 * ⚠️ PROD XAVFSIZLIGI: faqat ADD COLUMN (NULL yoki `DEFAULT false`) — mavjud
 * qatorlar (MAIN kassaning Asosiy va nomli kartalari) qayta yozilmaydi,
 * balanslar tegilmaydi. Hammasi `IF NOT EXISTS` / pg_constraint bilan
 * qo'riqlangan — qayta ishga tushirish xavfsiz. `down()` — aynan teskarisi.
 */
const TABLE = '"finance_schema"."cashbox_cards"';

const CONSTRAINTS: Array<[name: string, check: string]> = [
  [
    'CHK_CASHBOX_CARD_KIND',
    `"kind" IS NULL OR "kind" IN ('virtual_card', 'plastic_card', 'bank_account')`,
  ],
  ['CHK_CASHBOX_CARD_LAST4', `"last4" IS NULL OR "last4" ~ '^[0-9]{4}$'`],
  [
    'CHK_CASHBOX_CARD_AI_NEEDS_PHOTO',
    `"ai_check_enabled" = false OR "require_photo_on_shift_close" = true`,
  ],
];

export class CashboxCardDetails1716000000161 implements MigrationInterface {
  name = 'CashboxCardDetails1716000000161';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NULL,
        ADD COLUMN IF NOT EXISTS "bank_name" VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS "card_network" VARCHAR(30) NULL,
        ADD COLUMN IF NOT EXISTS "last4" VARCHAR(4) NULL,
        ADD COLUMN IF NOT EXISTS "holder_name" VARCHAR(150) NULL,
        ADD COLUMN IF NOT EXISTS "note" VARCHAR(500) NULL,
        ADD COLUMN IF NOT EXISTS "require_photo_on_shift_close" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "ai_check_enabled" BOOLEAN NOT NULL DEFAULT false
    `);
    for (const [name, check] of CONSTRAINTS) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = '${name}'
               AND conrelid = '${TABLE}'::regclass
          ) THEN
            ALTER TABLE ${TABLE} ADD CONSTRAINT "${name}" CHECK (${check});
          END IF;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...CONSTRAINTS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS "${name}"`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE ${TABLE}
        DROP COLUMN IF EXISTS "ai_check_enabled",
        DROP COLUMN IF EXISTS "require_photo_on_shift_close",
        DROP COLUMN IF EXISTS "note",
        DROP COLUMN IF EXISTS "holder_name",
        DROP COLUMN IF EXISTS "last4",
        DROP COLUMN IF EXISTS "card_network",
        DROP COLUMN IF EXISTS "bank_name",
        DROP COLUMN IF EXISTS "kind"
    `);
  }
}
