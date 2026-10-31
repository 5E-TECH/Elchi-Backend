import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B824gOu5 — kuryer chaqiruvi (pickup) tashrifi va haqi.
 *
 *  1. `finance_schema.cashbox_history_source_type_enum` va
 *     `finance_schema.financial_balance_history_source_type_enum` +=
 *     `pickup_fee` (ikki PG enum, qayta yurgizish xavfsiz).
 *  2. `finance_schema.pickup_visits` — tashrif jurnali: market, kuryer,
 *     posilka soni, haq, `is_free`, `idempotency_key` UNIQUE. Tekin tashrif
 *     ham qator. `is_free` faqat `fee = 0` bilan (CHECK).
 *
 * Mavjud qatorlar va pulga tegmaydi: yangi jadval, bo'sh. Kassa harakati
 * faqat `POST /finance/pickup-visits` chaqirilganda paydo bo'ladi.
 * ⚠️ `ADD VALUE` tranzaksiyada qo'shiladi, lekin yangi qiymat bu migratsiyada
 * ISHLATILMAYDI (Postgres cheklovi). `lock_timeout` 5 s (187 dagidek).
 *
 * down(): jadval o'chiriladi. Enum qiymatlari qoladi (Postgres qiymatni
 * o'chirishni qo'llamaydi, 186 dagidek) — `pickup_fee` tarix va daftar qatorlari
 * ham qoladi, kassa balansi ularga mos: revert pulni o'zgartirmaydi.
 */
export class PickupVisits1716000000198 implements MigrationInterface {
  name = 'PickupVisits1716000000198';

  private async addEnumValue(
    queryRunner: QueryRunner,
    typeName: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regtype('"finance_schema"."${typeName}"') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'finance_schema'
              AND t.typname = '${typeName}'
              AND e.enumlabel = 'pickup_fee'
          ) THEN
          ALTER TYPE "finance_schema"."${typeName}" ADD VALUE 'pickup_fee';
        END IF;
      END $$;
    `);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addEnumValue(queryRunner, 'cashbox_history_source_type_enum');
    await this.addEnumValue(
      queryRunner,
      'financial_balance_history_source_type_enum',
    );

    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
      BEGIN
        IF to_regnamespace('finance_schema') IS NULL THEN
          RETURN;
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);
        CREATE TABLE IF NOT EXISTS "finance_schema"."pickup_visits" (
          "id" BIGSERIAL NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "is_deleted" BOOLEAN NOT NULL DEFAULT false,
          "market_id" BIGINT NOT NULL,
          "courier_id" BIGINT NOT NULL,
          "parcel_count" INTEGER NOT NULL,
          "fee" NUMERIC(14,2) NOT NULL,
          "is_free" BOOLEAN NOT NULL DEFAULT false,
          "created_by" BIGINT NOT NULL,
          "occurred_at" TIMESTAMPTZ NOT NULL,
          "idempotency_key" VARCHAR(255) NOT NULL,
          "cashbox_history_id" BIGINT NULL,
          "fifo_applied_at" TIMESTAMPTZ NULL,
          "fifo_transfer_id" UUID NULL,
          CONSTRAINT "PK_pickup_visits_id" PRIMARY KEY ("id"),
          CONSTRAINT "CHK_PICKUP_VISITS_PARCELS" CHECK ("parcel_count" >= 1),
          CONSTRAINT "CHK_PICKUP_VISITS_FEE" CHECK ("fee" >= 0),
          CONSTRAINT "CHK_PICKUP_VISITS_FREE" CHECK ("is_free" = ("fee" = 0))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "UQ_PICKUP_VISITS_IDEMPOTENCY"
          ON "finance_schema"."pickup_visits" ("idempotency_key");
        CREATE INDEX IF NOT EXISTS "IDX_PICKUP_VISITS_MARKET"
          ON "finance_schema"."pickup_visits" ("market_id", "occurred_at");
        CREATE INDEX IF NOT EXISTS "IDX_PICKUP_VISITS_OCCURRED"
          ON "finance_schema"."pickup_visits" ("occurred_at");
        CREATE INDEX IF NOT EXISTS "IDX_PICKUP_VISITS_FIFO_OPEN"
          ON "finance_schema"."pickup_visits" ("market_id")
          WHERE "fifo_applied_at" IS NULL AND "fee" > 0 AND "is_deleted" = false;
        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS "finance_schema"."pickup_visits";
    `);
  }
}
