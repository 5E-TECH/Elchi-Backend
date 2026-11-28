import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * INVESTOR ULUSHI SANADAN BOSHLAB HISOBLANADI (BeePost `investor_ownership_stake`
 * naqshi, ega 2026-11-28).
 *
 * Ilgari investor foydasi faqat qo'lda yaratilgan `profit_shares` qatorlaridan
 * ko'rinardi — UI'da ularni yaratish yo'q edi, shuning uchun «investorlik
 * sanasi» 1-noyabr bo'lgan investorda ham kabinet bo'sh turardi. Endi ulush
 * har kun uchun kompaniya foydasidan (moliya daftari) avtomatik hisoblanadi.
 *
 * investor_schema:
 *   - `investors.profit_basis` — joriy foyda asosi: 'net' (sof foyda =
 *     daromad − xarajatlar) yoki 'gross' (daromad, xarajat ayrilmaydi).
 *     Sukut 'net' (BeePost sukuti bilan bir xil).
 *   - `investor_share_terms` — versiyalangan ulush shartlari: har qator
 *     [effective_from, effective_to) ISH KUNLARI oralig'ida amal qiladi
 *     (`effective_to` NULL — ochiq, hozirgi shart). Ulush o'zgarsa eski qator
 *     yopiladi, yangisi ochiladi — o'tgan kunlar hisobi o'zgarmaydi. Har
 *     investorda ko'pi bilan BITTA ochiq qator (qism unikal indeks).
 *
 * BACKFILL: «Ulush (%)» kiritilgan har bir faol investorga bitta ochiq shart —
 * boshi birinchi investitsiya sanasi (yaratish formasidagi «investorlik
 * sanasi» shu yerga yoziladi), investitsiya bo'lmasa — investor yaratilgan
 * kun (Toshkent sanasi). Asos — 'net'. Shart allaqachon bor investorga
 * tegilmaydi (qayta yurgizish xatosiz).
 *
 * down(): jadval va ustun o'chiriladi.
 */
export class InvestorShareTerms1716000000256 implements MigrationInterface {
  name = 'InvestorShareTerms1716000000256';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "investor_schema"."investors"
        ADD COLUMN IF NOT EXISTS "profit_basis" varchar(8) NOT NULL DEFAULT 'net'
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_investors_profit_basis'
        ) THEN
          ALTER TABLE "investor_schema"."investors"
            ADD CONSTRAINT "CHK_investors_profit_basis"
            CHECK ("profit_basis" IN ('net', 'gross'));
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_schema"."investor_share_terms" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "investor_id" bigint NOT NULL,
        "share_percent" NUMERIC(5,2) NOT NULL,
        "profit_basis" varchar(8) NOT NULL DEFAULT 'net',
        "effective_from" date NOT NULL,
        "effective_to" date NULL,
        "note" text NULL,
        "created_by" bigint NULL,
        CONSTRAINT "PK_investor_share_terms_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_investor_share_terms_percent"
          CHECK ("share_percent" >= 0 AND "share_percent" <= 100),
        CONSTRAINT "CHK_investor_share_terms_basis"
          CHECK ("profit_basis" IN ('net', 'gross')),
        CONSTRAINT "CHK_investor_share_terms_range"
          CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
        CONSTRAINT "FK_investor_share_terms_investor"
          FOREIGN KEY ("investor_id")
          REFERENCES "investor_schema"."investors" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_INVESTOR_SHARE_TERMS_FROM"
        ON "investor_schema"."investor_share_terms" ("investor_id", "effective_from")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_INVESTOR_SHARE_TERMS_OPEN"
        ON "investor_schema"."investor_share_terms" ("investor_id")
        WHERE "effective_to" IS NULL AND "is_deleted" = false
    `);

    await queryRunner.query(`
      INSERT INTO "investor_schema"."investor_share_terms"
        ("investor_id", "share_percent", "profit_basis", "effective_from", "note")
      SELECT
        i."id",
        i."share_percent",
        'net',
        (COALESCE(
          (
            SELECT MIN(inv."invested_at")
            FROM "investor_schema"."investments" inv
            WHERE inv."investor_id" = i."id" AND inv."is_deleted" = false
          ),
          i."createdAt"
        ) AT TIME ZONE 'Asia/Tashkent')::date,
        'Migratsiya 256: mavjud «Ulush (%)»'
      FROM "investor_schema"."investors" i
      WHERE i."is_deleted" = false
        AND i."share_percent" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "investor_schema"."investor_share_terms" t
          WHERE t."investor_id" = i."id"
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "investor_schema"."investor_share_terms"`,
    );
    await queryRunner.query(`
      ALTER TABLE "investor_schema"."investors"
        DROP CONSTRAINT IF EXISTS "CHK_investors_profit_basis"
    `);
    await queryRunner.query(`
      ALTER TABLE "investor_schema"."investors"
        DROP COLUMN IF EXISTS "profit_basis"
    `);
  }
}
