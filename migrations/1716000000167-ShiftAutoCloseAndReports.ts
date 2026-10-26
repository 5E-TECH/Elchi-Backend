import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * y8Tqm9Ap + gWI4gYkw — smenani jadval bo'yicha avtomatik yopish va yopilgan
 * smena hisobotini yuborish.
 *
 * `finance_schema.shifts` ga:
 *  - `close_reason` — `manual | auto` (ochiq smenada NULL; eski yopilgan
 *    smenalar NULL qoladi — API ularni `manual` deb ko'rsatadi, backfill YO'Q);
 *  - `closed_by_system` — tizim yopgan (avtomatik) bo'lsa true, `closed_by`
 *    shunda NULL;
 *  - `report_status` / `report_claimed_at` / `report_round` /
 *    `report_file_key` / `report_file_format` — hisobot yuborish navbati
 *    (yopish tranzaksiyasida `pending`, ishlov beruvchi atomik da'vo qiladi).
 *
 * `finance_schema.shift_schedule_claims` — bir martalik slot kaliti
 * (`auto_close:<shift_id>:<slot>`, `warn:<shift_id>:<slot>`): bir nechta
 * finance replikasi bir slotni faqat BIR marta bajaradi (PRIMARY KEY).
 *
 * `finance_schema.shift_report_deliveries` — hisobot kimga, qaysi kanal
 * orqali, qanday holatda ketgani (masalan `failed` + «Telegram ulanmagan»).
 * UNIQUE (shift_id, round, recipient_id, channel) — takror yozuv yo'q.
 *
 * ⚠️ PUL HARAKATI EMAS: kassa / karta balanslariga tegmaydi. Mavjud qatorlar
 * o'zgarmaydi (faqat yangi NULL / sukutli ustunlar). Qayta yurgizish xavfsiz.
 */
export class ShiftAutoCloseAndReports1716000000167 implements MigrationInterface {
  name = 'ShiftAutoCloseAndReports1716000000167';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
        ADD COLUMN IF NOT EXISTS "close_reason" VARCHAR(10) NULL,
        ADD COLUMN IF NOT EXISTS "closed_by_system" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "report_status" VARCHAR(16) NULL,
        ADD COLUMN IF NOT EXISTS "report_claimed_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "report_round" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "report_file_key" VARCHAR(500) NULL,
        ADD COLUMN IF NOT EXISTS "report_file_format" VARCHAR(8) NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'CHK_SHIFT_CLOSE_REASON'
        ) THEN
          ALTER TABLE "finance_schema"."shifts"
            ADD CONSTRAINT "CHK_SHIFT_CLOSE_REASON"
            CHECK ("close_reason" IS NULL OR "close_reason" IN ('manual','auto'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'CHK_SHIFT_REPORT_STATUS'
        ) THEN
          ALTER TABLE "finance_schema"."shifts"
            ADD CONSTRAINT "CHK_SHIFT_REPORT_STATUS"
            CHECK ("report_status" IS NULL OR "report_status" IN
              ('pending','processing','sent','skipped','failed'));
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIFT_REPORT_PENDING"
        ON "finance_schema"."shifts" ("report_status")
        WHERE "report_status" IN ('pending','processing')
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."shift_schedule_claims" (
        "key" VARCHAR(200) NOT NULL,
        "shift_id" BIGINT NOT NULL,
        "kind" VARCHAR(20) NOT NULL,
        "slot" VARCHAR(20) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shift_schedule_claims_key" PRIMARY KEY ("key")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."shift_report_deliveries" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "shift_id" BIGINT NOT NULL,
        "round" INTEGER NOT NULL DEFAULT 1,
        "recipient_id" BIGINT NOT NULL,
        "recipient_kind" VARCHAR(16) NOT NULL,
        "channel" VARCHAR(16) NOT NULL,
        "status" VARCHAR(16) NOT NULL,
        "failed_reason" VARCHAR(200) NULL,
        "dispatch_id" UUID NULL,
        "notification_type" VARCHAR(60) NOT NULL,
        "sent_at" TIMESTAMPTZ NULL,
        CONSTRAINT "PK_shift_report_deliveries_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_SHIFT_REPORT_DELIVERY_KIND" CHECK ("recipient_kind" IN
          ('superadmin','courier','market')),
        CONSTRAINT "CHK_SHIFT_REPORT_DELIVERY_CHANNEL" CHECK ("channel" IN
          ('in_app','telegram','telegram_group')),
        CONSTRAINT "CHK_SHIFT_REPORT_DELIVERY_STATUS" CHECK ("status" IN
          ('queued','sent','failed','skipped'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SHIFT_REPORT_DELIVERY"
        ON "finance_schema"."shift_report_deliveries"
          ("shift_id", "round", "recipient_id", "channel")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIFT_REPORT_DELIVERY_SHIFT"
        ON "finance_schema"."shift_report_deliveries" ("shift_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."shift_report_deliveries"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."shift_schedule_claims"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_SHIFT_REPORT_PENDING"`,
    );
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
        DROP CONSTRAINT IF EXISTS "CHK_SHIFT_REPORT_STATUS",
        DROP CONSTRAINT IF EXISTS "CHK_SHIFT_CLOSE_REASON",
        DROP COLUMN IF EXISTS "report_file_format",
        DROP COLUMN IF EXISTS "report_file_key",
        DROP COLUMN IF EXISTS "report_round",
        DROP COLUMN IF EXISTS "report_claimed_at",
        DROP COLUMN IF EXISTS "report_status",
        DROP COLUMN IF EXISTS "closed_by_system",
        DROP COLUMN IF EXISTS "close_reason"
    `);
  }
}
