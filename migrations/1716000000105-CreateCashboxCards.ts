import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 3PE0B03q (UZOQ MUDDAT) — BeePost `cashbox_card` tizimi porti: asosiy (MAIN)
 * kassa ichidagi NOMLI kartalar, karta ledgeri, kartalararo o'tkazma va
 * karta↔naqd konvertatsiya.
 *
 *   1. `finance_schema.cashbox_cards` — kartalar. Har kassada bitta "Asosiy
 *      karta" (`is_default`, partial unique indeks); nom kassa ichida noyob
 *      (katta-kichik harf farqsiz, o'chirilmaganlar orasida).
 *   2. `finance_schema.cashbox_card_movements` — ichki harakat jurnali
 *      (kirim/chiqim emas). `(cashbox_id, dedup_epoch)` noyob — takroriy
 *      so'rov ikkinchi harakat yozmaydi.
 *   3. `finance_schema.cashbox_history.card_id` — CLICK kirim/chiqim qaysi
 *      nomli kartaga tegishli (NULL — Asosiy karta / kartasiz).
 *
 * ⚠️ Mavjud ma'lumot O'ZGARTIRILMAYDI va SEED QILINMAYDI: BeePost migratsiyasi
 * joriy `balance_card` ni Asosiy kartaga ko'chirardi; Elchi'da Asosiy karta
 * balansi HOSILA (`balance_card − Σ nomli kartalar`), qator esa birinchi
 * murojaatda (`GET /finance/cashbox/cards`) yaratiladi. Shu bois invariant
 * 1-kundan to'g'ri va hech bir mavjud qator tegilmaydi.
 */
export class CreateCashboxCards1716000000105 implements MigrationInterface {
  name = 'CreateCashboxCards1716000000105';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "finance_schema"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."cashbox_cards" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "cashbox_id" BIGINT NOT NULL,
        "name" VARCHAR(100) NOT NULL,
        "balance" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "is_default" BOOLEAN NOT NULL DEFAULT false,
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "created_by" BIGINT NULL,
        CONSTRAINT "PK_cashbox_cards_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_CASHBOX_CARD_DEFAULT_ZERO"
          CHECK ("is_default" = false OR "balance" = 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_CARD_CASHBOX"
        ON "finance_schema"."cashbox_cards" ("cashbox_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CASHBOX_CARD_DEFAULT"
        ON "finance_schema"."cashbox_cards" ("cashbox_id")
        WHERE "is_default" = true AND "is_deleted" = false
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CASHBOX_CARD_NAME"
        ON "finance_schema"."cashbox_cards" ("cashbox_id", lower("name"))
        WHERE "is_deleted" = false
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."cashbox_card_movements" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "type" VARCHAR(16) NOT NULL,
        "cashbox_id" BIGINT NOT NULL,
        "from_card_id" BIGINT NULL,
        "to_card_id" BIGINT NULL,
        "amount" NUMERIC(20,2) NOT NULL,
        "balance_after_from" NUMERIC(20,2) NULL,
        "balance_after_to" NUMERIC(20,2) NULL,
        "comment" TEXT NULL,
        "created_by" BIGINT NULL,
        "dedup_epoch" VARCHAR(255) NULL,
        CONSTRAINT "PK_cashbox_card_movements_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_CARD_MOVEMENT_TYPE"
          CHECK ("type" IN ('card_to_card', 'card_to_cash', 'cash_to_card')),
        CONSTRAINT "CHK_CARD_MOVEMENT_AMOUNT" CHECK ("amount" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CARD_MOVEMENT_CASHBOX_CREATED"
        ON "finance_schema"."cashbox_card_movements" ("cashbox_id", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CARD_MOVEMENT_FROM"
        ON "finance_schema"."cashbox_card_movements" ("from_card_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CARD_MOVEMENT_TO"
        ON "finance_schema"."cashbox_card_movements" ("to_card_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CARD_MOVEMENT_DEDUP"
        ON "finance_schema"."cashbox_card_movements" ("cashbox_id", "dedup_epoch")
        WHERE "dedup_epoch" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        ADD COLUMN IF NOT EXISTS "card_id" BIGINT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_CARD"
        ON "finance_schema"."cashbox_history" ("card_id")
        WHERE "card_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_CARD"`,
    );
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        DROP COLUMN IF EXISTS "card_id"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."cashbox_card_movements"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."cashbox_cards"`,
    );
  }
}
