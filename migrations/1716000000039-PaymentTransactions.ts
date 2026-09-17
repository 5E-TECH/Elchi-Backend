import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `payment_transactions` — onlayn to'lov hodisalari.
 *
 * ⚠️ UNIQUE `(integration_id, provider_transaction_id, status)` jadvalning
 * ASOSIY maqsadi. To'lov tizimlari bir hodisani qayta-qayta yuboradi
 * (normal xatti-harakat) va pulni ikki marta qo'llash eng qimmat xato
 * bo'lardi.
 *
 * ⚠️ NEGA KALITGA `status` HAM KIRADI: bitta tranzaksiya uchun bir nechta
 * hodisa AYNI id bilan keladi (pending → succeeded → refunded). Kalit
 * faqat id bo'lsa, `pending` qatorni band qilib qo'yardi va pul kelgan
 * `succeeded` hodisasi "dublikat" deb tashlanardi.
 *
 * Jadval yangi — eski dublikat ma'lumot yo'q, shuning uchun UNIQUE
 * migratsiyani yiqitmaydi (`orders.external_id` da aynan shu sabab bilan
 * unique qo'yib bo'lmagan).
 */
export class PaymentTransactions1716000000039 implements MigrationInterface {
  name = 'PaymentTransactions1716000000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."payment_transactions" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "integration_id" bigint NOT NULL,
        "provider_transaction_id" character varying NOT NULL,
        "order_id" bigint,
        "order_ref" character varying,
        "amount" numeric(14,2) NOT NULL DEFAULT 0,
        "currency" character varying(8) NOT NULL DEFAULT 'UZS',
        "status" character varying(24) NOT NULL,
        "provider_status" character varying,
        "apply_outcome" character varying(32),
        "webhook_log_id" bigint,
        CONSTRAINT "PK_payment_transactions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PTX_INTEGRATION_TXN"
      ON "integration_schema"."payment_transactions"
        ("integration_id", "provider_transaction_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PTX_ORDER"
      ON "integration_schema"."payment_transactions" ("order_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_PTX_ORDER"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_PTX_INTEGRATION_TXN"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."payment_transactions"`,
    );
  }
}
