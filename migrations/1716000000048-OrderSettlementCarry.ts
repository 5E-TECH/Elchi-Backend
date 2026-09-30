import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `order_settlement_carry` — FIFO hisob-kitobida taqsimlanmay qolgan naqd.
 *
 * FIFO faqat butun buyurtmalarni yopadi; sig'magan qoldiq ilgari tashlab
 * yuborilardi va daftar kassadan orqada qolib ketardi (balans sun'iy oshardi,
 * navbatdagi buyurtma abadiy qotardi — E2E 30-09). Endi qoldiq tomon va bo'g'in
 * bo'yicha shu jadvalda saqlanadi va keyingi to'lovga qo'shiladi.
 *
 * Kod jadval yo'qligini tekshiradi (`to_regclass`) — migratsiya ishlamay qolsa
 * ham to'lovlar eski tartibda davom etadi. Idempotent (IF NOT EXISTS).
 */
export class OrderSettlementCarry1716000000048 implements MigrationInterface {
  name = 'OrderSettlementCarry1716000000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_schema"."order_settlement_carry" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "level" varchar(32) NOT NULL,
        "party_id" bigint NOT NULL,
        "branch_id" bigint,
        "amount" numeric(14,2) NOT NULL DEFAULT 0
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_order_settlement_carry_level_party"
        ON "order_schema"."order_settlement_carry" ("level", "party_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "order_schema"."order_settlement_carry";`,
    );
  }
}
