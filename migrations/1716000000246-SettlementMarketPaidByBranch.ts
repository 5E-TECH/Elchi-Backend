import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 63HO6cBU (P0, PR-C) — filial menejeri o'z filiali marketiga FILIAL
 * kassasidan to'laydi; daftar faqat (filial X, market M) qatorlarida yuradi:
 *   • `market_paid_by_branch_amount` — shu qator market ulushining filial
 *     to'lagan qismi (qisman ham; sukut 0). Filialning HQ'ga qarzi shu qatorda
 *     `branch_amount − market_paid_by_branch_amount`, HQ'ning marketga qarzi —
 *     `market_amount − market_paid_by_branch_amount`;
 *   • `market_paid_by_branch_at` / `_by` — market ulushi TO'LIQ to'langanda
 *     (holat COURIER_SETTLED qoladi; filial HQ'ga topshirganda darhol
 *     MARKET_SETTLED);
 *   • `order_settlement_branch_market_carry` (branch_id, market_id) — barcha
 *     (X, M) qatorlari to'langandan keyingi ortiqcha (faqat parallel so'rov
 *     poygasida); ulushdan va «HQ ga berilishi kerak» dan ayiriladi, keyingi
 *     (X, M) qatorlariga qo'llanadi — boshqa market / filialga O'TMAYDI.
 *
 * Faqat qo'shimchalar; backfill YO'Q (M4 dan beri qilingan tarixiy to'lovlar
 * qayta yozilmaydi — audit SQL: scripts/finance/audit-m4-branch-market-payments.sql).
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. `lock_timeout` 5 s (241/243/244
 * kabi). Relizda kam yuklamali vaqtda. down(): hammasi olib tashlanadi —
 * faqat filial → market to'lov holati yo'q (yoki konvertatsiya qilingan) bo'lsa.
 * up(): konvertatsiya izi bo'lsa rad etadi (Y-3d).
 */
export class SettlementMarketPaidByBranch1716000000246 implements MigrationInterface {
  name = 'SettlementMarketPaidByBranch1716000000246';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);
    // Y-3d — konvertatsiya izi bor (246 avval konvertatsiya + down() bilan
    // qaytarilgan): qayta up() filial to'lagan ulushlarni qayta tiriltiradi
    // (filial HQ'ga ham, marketga ham to'lagan bo'lib chiqadi). Fail-closed:
    // avval qayta solishtiring, so'ng izni tozalang.
    const [{ has_trace: hasTrace }] = (await queryRunner.query(`
      SELECT to_regclass('"order_schema"."order_settlement_246_conversion"')
               IS NOT NULL AS has_trace
    `)) as Array<{ has_trace: boolean }>;
    if (hasTrace) {
      const [{ traces }] = (await queryRunner.query(`
        SELECT count(*)::int AS traces
          FROM "order_schema"."order_settlement_246_conversion"
      `)) as Array<{ traces: number }>;
      if (traces > 0) {
        await restore();
        throw new Error(
          `Migratsiya 246 up() rad etildi: oldingi konvertatsiya izi bor ` +
            `(order_schema.order_settlement_246_conversion, ${traces} qator). ` +
            `Avval scripts/order/reconcile-246-after-reup.sql ni yurgizing ` +
            `(izdan filial to'lagan holatni tiklaydi, qoldiqlarni qaytaradi va ` +
            `izni o'chiradi), so'ng migration:run — aks holda filial to'lagan ` +
            `ulushlar ikki marta hisoblanadi.`,
        );
      }
    }
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_settlement"
        ADD COLUMN IF NOT EXISTS "market_paid_by_branch_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "market_paid_by_branch_by" bigint NULL,
        ADD COLUMN IF NOT EXISTS "market_paid_by_branch_amount" numeric(14,2) NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_schema"."order_settlement_branch_market_carry" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "branch_id" bigint NOT NULL,
        "market_id" bigint NOT NULL,
        "amount" numeric(14,2) NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_settlement_branch_market_carry"
        ON "order_schema"."order_settlement_branch_market_carry" ("branch_id", "market_id")
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

  /**
   * C2 — filial → market to'lov holati bor bo'lsa down() RAD etadi: ustunlar
   * jimgina o'chsa eski kod marketga ikkinchi marta to'lardi, filial esa HQ'ga
   * to'lagan summasini yana qarz bo'lib qolardi. Avval konvertatsiya:
   * `scripts/order/convert-246-before-down.sql` (filial to'lagan qism →
   * `order_settlement_carry` branch_to_hq / hq_to_market) — shundan keyin
   * tekshiruv o'zi o'tadi. Y-3c — chetlab o'tish (env) YO'Q: u faqat xavfli
   * yo'lni ochardi. Konvertatsiya izi (`order_settlement_246_conversion`)
   * down() da saqlanadi.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);
    const [{ has_column: hasColumn, has_carry: hasCarry }] =
      (await queryRunner.query(`
        SELECT EXISTS (
                 SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'order_schema'
                    AND table_name = 'order_settlement'
                    AND column_name = 'market_paid_by_branch_amount'
               ) AS has_column,
               to_regclass('"order_schema"."order_settlement_branch_market_carry"')
                 IS NOT NULL AS has_carry
      `)) as Array<{ has_column: boolean; has_carry: boolean }>;
    const [{ paid }] = hasColumn
      ? ((await queryRunner.query(`
          SELECT count(*)::int AS paid FROM "order_schema"."order_settlement"
           WHERE "market_paid_by_branch_amount" <> 0
              OR "market_paid_by_branch_at" IS NOT NULL
        `)) as Array<{ paid: number }>)
      : [{ paid: 0 }];
    const [{ carried }] = hasCarry
      ? ((await queryRunner.query(`
          SELECT count(*)::int AS carried
            FROM "order_schema"."order_settlement_branch_market_carry"
           WHERE "amount" <> 0
        `)) as Array<{ carried: number }>)
      : [{ carried: 0 }];
    // X737-1 — ikkinchi himoya: finance outbox'da (shu bazada) yetkazilmagan
    // filial → market advance bo'lsa, u konvertatsiyaga kirmagan.
    const [{ has_outbox: hasOutbox }] = (await queryRunner.query(`
      SELECT to_regclass('"finance_schema"."outbox_events"') IS NOT NULL AS has_outbox
    `)) as Array<{ has_outbox: boolean }>;
    const [{ in_flight: inFlight }] = hasOutbox
      ? ((await queryRunner.query(`
          SELECT count(*)::int AS in_flight
            FROM "finance_schema"."outbox_events"
           WHERE "status" IN ('pending', 'failed')
             AND "pattern" = 'order.settlement.advance'
             AND "payload"->>'level' = 'branch_to_market'
        `)) as Array<{ in_flight: number }>)
      : [{ in_flight: 0 }];
    if (inFlight > 0) {
      await restore();
      throw new Error(
        `Migratsiya 246 down() rad etildi: finance outbox'da ${inFlight} ta ` +
          `yetkazilmagan branch_to_market advance bor — menejer to'lovlarini ` +
          `o'chiring, xizmatlarni to'xtating, advance'lar yetkazilsin, so'ng ` +
          `scripts/order/convert-246-before-down.sql va down().`,
      );
    }
    if (paid > 0 || carried > 0) {
      await restore();
      throw new Error(
        `Migratsiya 246 down() rad etildi: filial → market to'lov holati bor ` +
          `(${paid} qator, ${carried} qoldiq). Avval ` +
          `scripts/order/convert-246-before-down.sql ni yurgizing (tartib — ` +
          `skript sarlavhasida), so'ng down() — aks holda eski kod marketga ` +
          `ikkinchi marta to'laydi.`,
      );
    }
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_order_settlement_branch_market_open"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "order_schema"."order_settlement_branch_market_carry"`,
    );
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_settlement"
        DROP COLUMN IF EXISTS "market_paid_by_branch_amount",
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
