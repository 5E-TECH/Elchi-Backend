import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kechiktirilgan qo'shimcha xarajat (SPEC v2, 2026-11-12, Dilshod: «buyurtma
 * joyida sotildi yoki bekor bo'ldi bo'lsin, ortiqcha harajatini o'zi
 * kutilmoqda bo'ladi — alohida tranzaksiya, qaysi tovar uchunligi
 * ko'rinsin»).
 *
 * `order_extra_cost_approvals`:
 * - `mode` — 'replay' (avvalgi xulq: tasdiqda amal qayta ijro bo'ladi;
 *   mavjud qatorlar shu) yoki 'deferred' (amal darhol E = 0 bilan bajarilgan,
 *   tasdiq faqat E ni alohida yozadi);
 * - `items` — so'rov qaysi tovarlar uchunligi (snapshot, nomlar o'qishda
 *   katalogdan);
 * - `deferred_snapshot` — tasdiqda QAYTA HISOBLAMASDAN yozish uchun kerak
 *   bo'lgan hamma narsa (qaysi kassa, hisob-kitob qatori boshlang'ich holati,
 *   oyoqlar va h.k.);
 * - `overage_applied_at` — tasdiqdagi ortiqcha market buyurtmalariga
 *   qo'llangan vaqt (aynan bir marta qo'llash belgisi).
 *
 * `order_settlement`:
 * - `kind` — 'sale' (sotuv/eski qatorlar — hammasi shu), 'extra_cost_chain'
 *   (kuryer/filial oyoqlari −E), 'extra_cost_market' (market oyog'i −E),
 *   'extra_cost_reversal' (rollback'da boshqa buyurtma FIFO'si ishlatib
 *   bo'lgan market qatori o'rniga +E kompensatsiya);
 * - `extra_cost_approval_id` — E qatorining so'rovi;
 * - buyurtma bo'yicha YAGONA qator endi faqat `kind = 'sale'` uchun
 *   (qisman unikal indeks); E qatorlari so'rov+tur bo'yicha yagona.
 *
 * `IF [NOT] EXISTS` — qayta yurgizish xatosiz. Postgres 11+ da `DEFAULT`
 * bilan ustun qo'shish faqat katalog o'zgarishi — backfill UPDATE yo'q.
 */
export class ExtraCostDeferred1716000000219 implements MigrationInterface {
  name = 'ExtraCostDeferred1716000000219';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
        ADD COLUMN IF NOT EXISTS "mode" VARCHAR(16) NOT NULL DEFAULT 'replay',
        ADD COLUMN IF NOT EXISTS "items" JSONB NULL,
        ADD COLUMN IF NOT EXISTS "deferred_snapshot" JSONB NULL,
        ADD COLUMN IF NOT EXISTS "overage_applied_at" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_settlement"
        ADD COLUMN IF NOT EXISTS "kind" VARCHAR(24) NOT NULL DEFAULT 'sale',
        ADD COLUMN IF NOT EXISTS "extra_cost_approval_id" BIGINT NULL
    `);

    // Eski unikal indeks (order_id bo'yicha bitta qator) E qatorlariga xalaqit
    // beradi — o'rniga sotuv qatori uchun qisman unikal + oddiy qidiruv indeksi.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."IDX_order_settlement_order_id"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_order_settlement_sale_order"
        ON "order_schema"."order_settlement" ("order_id")
        WHERE "kind" = 'sale'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_settlement_order"
        ON "order_schema"."order_settlement" ("order_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_order_settlement_extra_cost_kind"
        ON "order_schema"."order_settlement" ("extra_cost_approval_id", "kind")
        WHERE "extra_cost_approval_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DIQQAT: orqaga qaytarishda E qatorlari (kind <> 'sale') O'CHIRILADI —
    // aks holda eski unikal indeks (order_id) qurilmaydi. Ular ko'rsatgan
    // pul (kassa oyoqlari, daftar) joyida qoladi; down faqat favqulodda.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."UQ_order_settlement_extra_cost_kind"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."IDX_order_settlement_order"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."UQ_order_settlement_sale_order"
    `);
    await queryRunner.query(`
      DELETE FROM "order_schema"."order_settlement" WHERE "kind" <> 'sale'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_settlement_order_id"
        ON "order_schema"."order_settlement" ("order_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_settlement"
        DROP COLUMN IF EXISTS "extra_cost_approval_id",
        DROP COLUMN IF EXISTS "kind"
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
        DROP COLUMN IF EXISTS "overage_applied_at",
        DROP COLUMN IF EXISTS "deferred_snapshot",
        DROP COLUMN IF EXISTS "items",
        DROP COLUMN IF EXISTS "mode"
    `);
  }
}
