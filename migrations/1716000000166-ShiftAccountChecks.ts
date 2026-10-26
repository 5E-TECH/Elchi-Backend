import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * kiZgTybn — smena yopilishida har karta / hisob raqam qoldig'ini tasdiqlash.
 *
 * `finance_schema.shift_account_checks` — smena × karta bo'yicha bitta qator
 * (UNIQUE shift_id + cashbox_card_id): rasm yuklanganda QORALAMA sifatida
 * yaratiladi, yopishda yakunlanadi. `expected_balance` — tizim qoldig'i
 * SNAPSHOT'i (yopish paytida qayta yoziladi), `difference` = kiritilgan −
 * kutilgan. AI natijasi (`ai_*`) asinxron yoziladi; `ai_raw` — faqat
 * {balance, last4, date, confidence} (to'liq karta raqami/PII YO'Q).
 * `photo_required_snap` / `ai_enabled_snap` — yopish paytidagi qoidalar.
 *
 * `finance_schema.finance_settings` — global key/value sozlamalar (faqat
 * superadmin o'zgartiradi): `shift.account_check.enabled`,
 * `shift.photo.required`, `shift.ai_check.enabled`. Qator yo'q — kod sukuti.
 *
 * ⚠️ Bu jadvallar PUL HARAKATI EMAS: kassa / karta balanslariga tegmaydi.
 * Qayta yurgizish xavfsiz (IF NOT EXISTS). Ma'lumotga tegmaydi.
 */
export class ShiftAccountChecks1716000000166 implements MigrationInterface {
  name = 'ShiftAccountChecks1716000000166';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."shift_account_checks" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "shift_id" BIGINT NOT NULL,
        "cashbox_card_id" BIGINT NOT NULL,
        "expected_balance" NUMERIC(20,2) NULL,
        "entered_balance" NUMERIC(20,2) NULL,
        "difference" NUMERIC(20,2) NULL,
        "photo_file_key" VARCHAR(500) NULL,
        "photo_uploaded_at" TIMESTAMPTZ NULL,
        "photo_uploaded_by" BIGINT NULL,
        "ai_status" VARCHAR(16) NOT NULL DEFAULT 'not_required',
        "ai_request_id" UUID NULL,
        "ai_read_balance" NUMERIC(20,2) NULL,
        "ai_last4_detected" VARCHAR(4) NULL,
        "ai_date_detected" VARCHAR(40) NULL,
        "ai_confidence" NUMERIC(4,3) NULL,
        "ai_entered_ok" BOOLEAN NULL,
        "ai_model" VARCHAR(80) NULL,
        "ai_checked_at" TIMESTAMPTZ NULL,
        "ai_raw" JSONB NULL,
        "comment" TEXT NULL,
        "photo_required_snap" BOOLEAN NOT NULL DEFAULT false,
        "ai_enabled_snap" BOOLEAN NOT NULL DEFAULT false,
        "confirmed_at" TIMESTAMPTZ NULL,
        "confirmed_by" BIGINT NULL,
        CONSTRAINT "PK_shift_account_checks_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_SHIFT_ACCOUNT_CHECK_AI_STATUS" CHECK ("ai_status" IN
          ('not_required','pending','match','mismatch','unreadable','disabled','error')),
        CONSTRAINT "CHK_SHIFT_ACCOUNT_CHECK_LAST4"
          CHECK ("ai_last4_detected" IS NULL OR "ai_last4_detected" ~ '^[0-9]{4}$')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SHIFT_ACCOUNT_CHECK_SHIFT_CARD"
        ON "finance_schema"."shift_account_checks" ("shift_id", "cashbox_card_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIFT_ACCOUNT_CHECK_PENDING"
        ON "finance_schema"."shift_account_checks" ("shift_id")
        WHERE "ai_status" = 'pending'
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."finance_settings" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "key" VARCHAR(100) NOT NULL,
        "value" JSONB NOT NULL,
        "updated_by" BIGINT NULL,
        CONSTRAINT "PK_finance_settings_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_FINANCE_SETTINGS_KEY"
        ON "finance_schema"."finance_settings" ("key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."finance_settings"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."shift_account_checks"`,
    );
  }
}
