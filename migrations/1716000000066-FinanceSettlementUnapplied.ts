import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * znD3KaZL — `finance_schema.finance_settlement_unapplied`: FIFO hisob-kitobida
 * butun buyurtmaga sig'magan qoldiq (`order.settlement.advance` javobidagi
 * `leftover` > 0) jurnali.
 *
 * Faqat ko'rsatkich / audit: qoldiqning o'zi `order_schema.
 * order_settlement_carry` da (1716000000048) va keyingi to'lovga qo'shiladi.
 * Bu jadval kassa harakatlariga ham, qoldiq mexanizmiga ham ta'sir qilmaydi.
 *
 * Idempotentlik: `(level, actor_id, dedup_epoch)` UNIQUE — tezkor yo'l
 * (finance advance javobini o'qiydi) va sekin yo'l (order-service outbox
 * hodisasi `finance.settlement.unapplied_recorded`) ikkalasi ham
 * `ON CONFLICT DO NOTHING` bilan yozadi → bitta qator.
 *
 * Har migratsiya bir marta `order_schema.migrations` da yoziladi va o'z
 * sxemasini qattiq ko'rsatadi (1716000000012 bilan bir xil naqsh).
 *
 * ⚠️ DEPLOY TARTIBI: shu migratsiya finance-service / order-service yangi
 * versiyasidan OLDIN. Aks holda hodisa (`finance.*` — doimiy pattern)
 * jadval paydo bo'lguncha order-service outbox'ida qayta urinib turadi
 * ("STUCK" ogohlantirishi), to'lovlar esa odatdagidek o'tadi.
 */
export class FinanceSettlementUnapplied1716000000066 implements MigrationInterface {
  name = 'FinanceSettlementUnapplied1716000000066';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."finance_settlement_unapplied" (
        "id" BIGSERIAL PRIMARY KEY,
        "actor_id" bigint NOT NULL,
        "level" varchar(32) NOT NULL,
        "amount" numeric(14,2) NOT NULL,
        "dedup_epoch" varchar NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_finance_settlement_unapplied_level_actor_epoch"
        ON "finance_schema"."finance_settlement_unapplied" ("level", "actor_id", "dedup_epoch");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."finance_settlement_unapplied";`,
    );
  }
}
