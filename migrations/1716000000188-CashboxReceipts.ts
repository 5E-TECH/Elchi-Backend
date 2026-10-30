import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T3 (QlLf33Ma) — kassa CHEKI: `finance_schema.cashbox_receipts`.
 *
 * Bir qator — bitta chek rasmi. Yuklanganda `draft` (operatsiyasiz), qo'lda
 * chiqim yoki HQ'ga o'tkazma saqlanganda `linked`: `history_id` — chiqim
 * (yoki MAIN INCOME), `counter_history_id` — qarshi oyoq (kuryer / filial
 * EXPENSE). AI ustunlari ham shu yerda (T3-3 migratsiyasiz).
 *
 * SAQLASH: `linked` qator va fayli avtomatik O'CHIRILMAYDI. Cron faqat 24
 * soatdan eski `draft` ni soft-delete qiladi (faylni ham o'chiradi).
 *
 * XAVFSIZLIK: PULGA TEGMAYDI — yangi jadval, mavjud jadvallar o'zgarmaydi.
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. down(): jadval o'chiriladi
 * (cheklar bog'lanishi yo'qoladi; fayllar file-service'da qoladi).
 */
export class CashboxReceipts1716000000188 implements MigrationInterface {
  name = 'CashboxReceipts1716000000188';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "finance_schema"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."cashbox_receipts" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "deleted_at" TIMESTAMPTZ NULL,
        "kind" VARCHAR(24) NOT NULL,
        "state" VARCHAR(16) NOT NULL DEFAULT 'draft',
        "history_id" BIGINT NULL,
        "counter_history_id" BIGINT NULL,
        "branch_id" BIGINT NULL,
        "courier_id" BIGINT NULL,
        "card_id" BIGINT NULL,
        "entered_amount" NUMERIC(20,2) NULL,
        "payment_method" VARCHAR(32) NULL,
        "linked_at" TIMESTAMPTZ NULL,
        "linked_by" BIGINT NULL,
        "file_key" VARCHAR(500) NOT NULL,
        "file_sha256" CHAR(64) NOT NULL,
        "mime" VARCHAR(32) NOT NULL,
        "size_bytes" INTEGER NOT NULL,
        "uploaded_by" BIGINT NOT NULL,
        "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "photo_required_snap" BOOLEAN NOT NULL DEFAULT false,
        "ai_enabled_snap" BOOLEAN NOT NULL DEFAULT false,
        "ai_status" VARCHAR(16) NOT NULL DEFAULT 'disabled',
        "ai_request_id" UUID NULL,
        "ai_requested_at" TIMESTAMPTZ NULL,
        "ai_attempts" INTEGER NOT NULL DEFAULT 0,
        "ai_error_reason" VARCHAR(64) NULL,
        "ai_amount" NUMERIC(20,2) NULL,
        "ai_difference" NUMERIC(20,2) NULL,
        "ai_currency" VARCHAR(8) NULL,
        "ai_date" VARCHAR(40) NULL,
        "ai_recipient" VARCHAR(120) NULL,
        "ai_recipient_last4" VARCHAR(4) NULL,
        "ai_payer" VARCHAR(120) NULL,
        "ai_payer_last4" VARCHAR(4) NULL,
        "ai_bank" VARCHAR(80) NULL,
        "ai_reference" VARCHAR(120) NULL,
        "ai_confidence" NUMERIC(4,3) NULL,
        "ai_flags" JSONB NULL,
        "ai_model" VARCHAR(80) NULL,
        "ai_checked_at" TIMESTAMPTZ NULL,
        CONSTRAINT "PK_cashbox_receipts_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_CASHBOX_RECEIPTS_KIND"
          CHECK ("kind" IN ('manual_expense', 'courier_to_hq', 'branch_to_hq')),
        CONSTRAINT "CHK_CASHBOX_RECEIPTS_STATE"
          CHECK ("state" IN ('draft', 'linked')),
        CONSTRAINT "CHK_CASHBOX_RECEIPTS_AI_STATUS"
          CHECK ("ai_status" IN ('disabled', 'pending', 'match', 'mismatch', 'unreadable', 'error')),
        CONSTRAINT "CHK_CASHBOX_RECEIPTS_LINKED"
          CHECK ("state" = 'draft' OR "history_id" IS NOT NULL),
        CONSTRAINT "CHK_CASHBOX_RECEIPTS_ATTEMPTS"
          CHECK ("ai_attempts" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CASHBOX_RECEIPTS_HISTORY"
        ON "finance_schema"."cashbox_receipts" ("history_id")
        WHERE "is_deleted" = false AND "history_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_RECEIPTS_COUNTER_HISTORY"
        ON "finance_schema"."cashbox_receipts" ("counter_history_id")
        WHERE "counter_history_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_RECEIPTS_STATE_UPLOADED"
        ON "finance_schema"."cashbox_receipts" ("state", "uploaded_at")
        WHERE "is_deleted" = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_RECEIPTS_SHA256"
        ON "finance_schema"."cashbox_receipts" ("file_sha256")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_RECEIPTS_AI_REFERENCE"
        ON "finance_schema"."cashbox_receipts" ("ai_reference")
        WHERE "ai_reference" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."cashbox_receipts"`,
    );
  }
}
