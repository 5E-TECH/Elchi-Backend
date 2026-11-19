import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 63HO6cBU (P0, PR-C) — filial menejeri o'z filiali marketiga FILIAL
 * kassasidan to'laganda daftar qatori «market ulushi filial tomonidan
 * to'langan» deb belgilanadi (holat COURIER_SETTLED qoladi):
 *   • `market_paid_by_branch_at` / `_by` — qachon / kim (NULL — to'lanmagan);
 *   • bunday qator uchun filialning HQ'ga qarzi = branch_amount − market_amount
 *     (HQ ulushi), filial HQ'ga topshirganda qator darhol MARKET_SETTLED
 *     bo'ladi (HQ marketga qayta to'lamaydi).
 *
 * Faqat qo'shimcha nullable ustunlar + qisman indeks; backfill YO'Q (M4 dan
 * beri qilingan tarixiy to'lovlar qayta yozilmaydi — audit SQL alohida:
 * scripts/finance/audit-m4-branch-market-payments.sql).
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. `lock_timeout` 5 s (241/243/244
 * kabi). Indeks qurilishi `order_settlement` ga yozishni qisqa kutdiradi —
 * relizda kam yuklamali vaqtda. down(): indeks va ustunlar olib tashlanadi.
 */
export class SettlementMarketPaidByBranch1716000000246 implements MigrationInterface {
  name = 'SettlementMarketPaidByBranch1716000000246';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_settlement"
        ADD COLUMN IF NOT EXISTS "market_paid_by_branch_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "market_paid_by_branch_by" bigint NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_settlement_branch_market_open"
        ON "order_schema"."order_settlement" ("branch_id", "market_id", "createdAt", "id")
        WHERE "status" = 'courier_settled'
          AND "market_paid_by_branch_at" IS NULL
          AND "is_deleted" = false
    `);
    await restore();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_order_settlement_branch_market_open"`,
    );
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_settlement"
        DROP COLUMN IF EXISTS "market_paid_by_branch_by",
        DROP COLUMN IF EXISTS "market_paid_by_branch_at"
    `);
    await restore();
  }

  /** `lock_timeout` 5 s (tranzaksiya ichida, `is_local`); qaytaruvchi funksiya. */
  private async lockTimeout(
    queryRunner: QueryRunner,
  ): Promise<() => Promise<void>> {
    const [{ previous }] = (await queryRunner.query(
      `SELECT current_setting('lock_timeout') AS previous`,
    )) as Array<{ previous: string }>;
    await queryRunner.query(`SELECT set_config('lock_timeout', '5s', true)`);
    return async () => {
      await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
        previous,
      ]);
    };
  }
}
