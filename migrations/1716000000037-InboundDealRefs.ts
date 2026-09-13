import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `inbound_deal_refs` — CRM bitimi ↔ buyurtma bog'lanishi.
 *
 * NEGA KERAK. `receiveExternalOrders` dublikatni o'qib tekshiradi, keyin
 * yaratadi; ikkisi orasida RMQ chaqiruvlari bor, ya'ni poyga oynasi katta.
 * CRM bitta harakat uchun bir nechta webhook yuboradi va hammasi ayni
 * bosqichni tashiydi — ikkisi bir vaqtda kelsa bitta bitimdan IKKI buyurtma
 * tug'ilardi.
 *
 * ⚠️ USTUN NOMI `is_deleted` (snake_case), `isDeleted` EMAS. `BaseEntity`
 * da `@Column({ name: 'is_deleted' })` turadi — xossa camelCase, ustun esa
 * snake_case. Bu yerda ilgari `"isDeleted"` yozilgan edi va har bir INSERT
 * `42703 undefined column` bilan yiqilardi. `createdAt`/`updatedAt` esa
 * aksincha camelCase (ularda `name:` yo'q) — ikkisini aralashtirmaslik kerak.
 *
 * `orders` ustiga UNIQUE indeks qo'yish xavfli edi: `external_id` NULL
 * bo'lishi mumkin va mavjud ma'lumotdagi dublikat migratsiyani yiqitardi.
 * Bu jadval yangi — eski ma'lumot yo'q, UNIQUE xavfsiz.
 */
export class InboundDealRefs1716000000037 implements MigrationInterface {
  name = 'InboundDealRefs1716000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."inbound_deal_refs" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "integration_id" bigint NOT NULL,
        "deal_id" character varying NOT NULL,
        "order_id" bigint,
        "stage" character varying,
        CONSTRAINT "PK_inbound_deal_refs" PRIMARY KEY ("id")
      )
    `);
    /**
     * ⚠️ UNIQUE — dublikat to'sig'ining O'ZI. Oddiy indeks bo'lsa poyga
     * ochiq qolardi: ikki webhook bir vaqtda o'qib, ikkisi ham yozardi.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_IDR_INTEGRATION_DEAL"
      ON "integration_schema"."inbound_deal_refs" ("integration_id", "deal_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_IDR_INTEGRATION_DEAL"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."inbound_deal_refs"`,
    );
  }
}
