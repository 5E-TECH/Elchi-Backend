import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (2crjWf7v #4) Kuryerning kvitansiyaga javobi — FAQAT AUDIT yozuvi, kassaga
 * ta'sir qilmaydi. `payment_id` — kuryer kassasidagi `cashbox_history`
 * (COURIER_PAYMENT, EXPENSE) qatori. Bir kvitansiyaga bitta javob
 * (`UQ_COURIER_PAYMENT_ACK`): ikki marta bosish ikkinchi yozuv yaratmaydi.
 * Faqat sxema; qayta ishga tushirish xavfsiz.
 */
export class CourierPaymentAcks1716000000125 implements MigrationInterface {
  name = 'CourierPaymentAcks1716000000125';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."courier_payment_acks" (
        "id" BIGSERIAL PRIMARY KEY,
        "payment_id" bigint NOT NULL,
        "courier_id" bigint NOT NULL,
        "ack" varchar(16) NOT NULL,
        "comment" varchar(500) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_COURIER_PAYMENT_ACK" CHECK ("ack" IN ('confirmed', 'disputed'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_COURIER_PAYMENT_ACK"
      ON "finance_schema"."courier_payment_acks" ("payment_id", "courier_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_COURIER_PAYMENT_ACK_DISPUTED"
      ON "finance_schema"."courier_payment_acks" ("created_at")
      WHERE "ack" = 'disputed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."courier_payment_acks"`,
    );
  }
}
