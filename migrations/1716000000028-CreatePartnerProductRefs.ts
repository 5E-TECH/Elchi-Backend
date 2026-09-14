import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `partner_product_refs` — hamkor mahsuloti ↔ Elchi katalogidagi mahsulot.
 *
 * MUAMMO. Hamkor (Partner API) posilkasidagi mahsulotlar Elchi katalogida
 * yo'q edi: buyurtma qatori `product_id = NULL`, nom esa `product_name` da
 * matn bo'lib saqlanardi. Oqibati:
 *   • UI mahsulot nomini katalogdan olardi va katalogsiz qatorda yiqilardi;
 *   • mahsulot bo'yicha hisobot/qidiruvda hamkor mahsulotlari KO'RINMASDI —
 *     ular katalogda mavjud emas edi.
 *
 * YECHIM. Mahsulot avtomatik yaratiladi (yo'q bo'lsa) va bog'lanish shu
 * jadvalda saqlanadi. Keyingi posilkalarda o'sha mahsulot QAYTA ISHLATILADI.
 *
 * BOG'LANISH ID BO'YICHA, NOM BO'YICHA EMAS. Nom o'zgaruvchan: hamkor uni
 * tahrirlashi mumkin, ikki mahsulot bir xil nomda bo'lishi mumkin. Nom
 * bo'yicha bog'lansak, nom tuzatilgan zahoti katalogda dublikat paydo
 * bo'lardi va hisobot bitta mahsulotni ikkiga bo'lardi.
 */
export class CreatePartnerProductRefs1716000000028
  implements MigrationInterface
{
  name = 'CreatePartnerProductRefs1716000000028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."partner_product_refs" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "partner_id" BIGINT NOT NULL,
        "external_product_id" VARCHAR NOT NULL,
        "elchi_product_id" BIGINT NOT NULL,
        "elchi_market_id" BIGINT NOT NULL
      );
    `);

    /**
     * `partner_id` bilan birga noyob: ikki hamkor bir xil
     * `external_product_id` ishlatishi mumkin va ular aralashmasligi kerak.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PPR_PARTNER_EXTERNAL"
      ON "integration_schema"."partner_product_refs" ("partner_id", "external_product_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PPR_PRODUCT"
      ON "integration_schema"."partner_product_refs" ("elchi_product_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * Jadval o'chiriladi, lekin katalogda YARATILGAN mahsulotlarga
     * TEGILMAYDI: ular allaqachon buyurtma qatorlariga bog'langan bo'lishi
     * mumkin. Ularni o'chirish tarixni buzardi.
     */
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."partner_product_refs"`,
    );
  }
}
