import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `inbound_deal_refs.isDeleted` → `is_deleted` — YO'L-YO'LAKAY TUZATISH.
 *
 * ⚠️ NIMA BO'LGAN. `1716000000037-InboundDealRefs` jadvalni `"isDeleted"`
 * ustuni bilan yaratgan. `BaseEntity` esa
 * `@Column({ name: 'is_deleted' })` ishlatadi — ya'ni xossa camelCase,
 * USTUN snake_case. Natijada har bir INSERT `42703 undefined column`
 * bilan yiqilardi va CRM voronkasidan buyurtma yaratish yo'li ishlamasdi
 * (webhook 500 qaytarardi).
 *
 * Amalda zarar YO'Q edi: hech bir CRM ulanmagan, ya'ni bu yo'lga hech kim
 * kirmagan. Lekin tuzatish provayder ulanishidan OLDIN bo'lishi shart.
 *
 * ⚠️ `createdAt`/`updatedAt` bilan ARALASHTIRMANG: ularda `name:` yo'q,
 * shuning uchun ular HAQIQATAN camelCase ustunlar. Faqat `isDeleted`
 * boshqacha.
 *
 * Migratsiya IDEMPOTENT: `1716000000037` allaqachon tuzatilgan, shuning
 * uchun yangi bazada `isDeleted` umuman bo'lmaydi va bu yer no-op bo'ladi.
 */
export class FixSoftDeleteColumnName1716000000041
  implements MigrationInterface
{
  name = 'FixSoftDeleteColumnName1716000000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'integration_schema'
            AND table_name = 'inbound_deal_refs'
            AND column_name = 'isDeleted'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'integration_schema'
            AND table_name = 'inbound_deal_refs'
            AND column_name = 'is_deleted'
        ) THEN
          ALTER TABLE "integration_schema"."inbound_deal_refs"
            RENAME COLUMN "isDeleted" TO "is_deleted";
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    /**
     * Teskari qadam ATAYLAB bo'sh: `isDeleted` ga qaytarish jadvalni yana
     * ishlamaydigan holatga keltirardi. Noto'g'ri holatni "tiklash" kerak
     * emas.
     */
  }
}
