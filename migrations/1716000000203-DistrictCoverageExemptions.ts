import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tuman qamrovi IMTIYOZLARI (ega qarori, 2026-11-02):
 * `logistics_schema.district_coverage_exemptions`.
 *
 * Muammo: tuman ko'chirilsa (boshqa viloyatga yoki boshqa xizmat filialiga)
 * eski filialda / uning kuryerida turgan ochiq buyurtmalar qotib qolardi —
 * eski filial ularni o'z kuryeriga bera olmaydi (`isOrderServedByBranch`).
 * Qaror: ko'chish PAYTIDA eski filial (yoki uning kuryeri) qo'lidagi
 * buyurtmalar eski filialda tugaydi. Logistika ko'chishdan oldin shunday
 * (buyurtma, filial) juftlarini shu jadvalga yozadi va kuryerga berishda
 * qamrov tekshiruvi ularni o'tkazadi.
 *
 * Ustunlar: `order_id` (order-service), `branch_id` (branch-service),
 * `district_id` (ko'chishdan keyingi buyurtma tumani — imtiyoz faqat
 * buyurtma hozir shu tumanda bo'lsa amal qiladi), `source` (qaysi amal
 * yozdi), `created_at`, `revoked_at` (NULL — amalda).
 * (`order_id`, `branch_id`) — UNIQUE: yozish `ON CONFLICT … DO UPDATE`
 * (keyingi ko'chish juftni yangi tumanga qayta yo'naltiradi).
 *
 * FK YO'Q ataylab (1716000000200 kabi): buyurtmalar va filiallar boshqa
 * sxemalarda (`order_schema`, `branch_schema`).
 *
 * XAVFSIZLIK: pulga va buyurtmalarga tegmaydi — yangi bo'sh jadval.
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. `CONCURRENTLY` yo'q: production
 * kutilgan migratsiyalarni BITTA tranzaksiyada yurgizadi
 * (scripts/db-prepare.ts). down(): jadval (indekslari bilan) o'chiriladi.
 */
export class DistrictCoverageExemptions1716000000203 implements MigrationInterface {
  name = 'DistrictCoverageExemptions1716000000203';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "logistics_schema"."district_coverage_exemptions" (
        "id" bigserial PRIMARY KEY,
        "order_id" bigint NOT NULL,
        "branch_id" bigint NOT NULL,
        "district_id" bigint NULL,
        "source" varchar(32) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_DISTRICT_COVERAGE_EXEMPTION_ORDER_BRANCH"
        ON "logistics_schema"."district_coverage_exemptions" ("order_id", "branch_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_DISTRICT_COVERAGE_EXEMPTION_BRANCH"
        ON "logistics_schema"."district_coverage_exemptions" ("branch_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS "logistics_schema"."district_coverage_exemptions"
    `);
  }
}
