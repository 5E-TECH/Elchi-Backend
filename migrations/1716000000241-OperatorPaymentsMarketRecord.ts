import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F2qp6FtE (ega qarori 2026-11-16) — market o'z operatoriga O'ZI to'laydi;
 * Elchi Asosiy kassasi bunga tegmaydi. Tizim faqat hisob yozuvini saqlaydi.
 *
 * `finance_schema.operator_payments` ga ustunlar:
 *  - `source` VARCHAR(16) NOT NULL DEFAULT 'elchi' — kim yozgan: `elchi`
 *    (eski yo'l: superadmin «Moliya operatorlari» dan, Elchi pulidan) yoki
 *    `market` (yangi: market o'zi yozadi, kassasiz);
 *  - `affects_cashbox` BOOLEAN NOT NULL DEFAULT true — yozuv Asosiy kassani
 *    o'zgartirganmi. Mavjud qatorlar MA'LUMOTDAN belgilanadi: unga
 *    `cashbox_history` (salary · expense · `source_id` = to'lov id) yoki P&L
 *    daftarida `operator-payment:<id>` qatori bo'lsa — true, aks holda false
 *    (AUDIT M6 dan oldingi, kassasiz yozilgan eski qatorlar);
 *  - `paid_at` DATE NOT NULL — to'lov sanasi (Toshkent kuni). Mavjud qatorlar
 *    `createdAt` ning Toshkent sanasi bilan to'ldiriladi;
 *  - `recorded_by_role` VARCHAR(32) — yozgan rol (eski qatorlarda NULL;
 *    yozgan foydalanuvchi — avvalgidek `paid_by_id`);
 *  - `idempotency_key` VARCHAR(255) + UNIQUE (`market_id`, `idempotency_key`)
 *    (kalitli qatorlar) — timeout'dan keyingi qayta yuborish ikkinchi yozuv
 *    yaratmaydi;
 *  - `cancelled_at`, `cancelled_by_id`, `cancelled_by_role`, `cancel_reason` —
 *    xato yozuvni bekor qilish (qator qoladi, «To'landi» ga kirmaydi).
 *
 * CHECK'lar (yangi qatorlar uchun kafolat, mavjudlariga mos):
 *  - `source` ∈ {elchi, market};
 *  - market yozuvi HECH QACHON kassaga ta'sir qilmaydi, `market_id` bor va
 *    summa > 0;
 *  - bekor qilish faqat market yozuvida va sabab bilan.
 *
 * DEPLOY OYNASI: migratsiya servislar qayta ishga tushishidan OLDIN yuradi —
 * shu oraliqda ESKI finance-service hali kassadan to'lov yozishi mumkin.
 * Ustun sukutlari (`source = 'elchi'`, `affects_cashbox = true`, `paid_at` =
 * bugungi Toshkent kuni) aynan shu eski yozuvni to'g'ri belgilaydi. Yangi kod
 * har uch ustunni o'zi aniq yozadi.
 *
 * Pul va kassa tarixiga TEGMAYDI: kassa balansi, `cashbox_history`,
 * `financial_balance_history` va xarajatlar o'zgarmaydi. Qayta yurgizish
 * xatosiz. Jadval bo'lmasa — o'tkazib yuboriladi. `lock_timeout` 5 s.
 *
 * down(): bekor qilingan qatorlar `is_deleted = true` bo'ladi (eski kod ularni
 * «to'langan» deb qayta sanamasin), so'ng ustun, CHECK va indekslar olinadi.
 * Market yozuvlari qoladi — eski kod ularni oddiy to'lov deb ko'radi (kassa
 * baribir o'zgarmagan).
 */
export class OperatorPaymentsMarketRecord1716000000241 implements MigrationInterface {
  name = 'OperatorPaymentsMarketRecord1716000000241';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
        has_history boolean :=
          to_regclass('"finance_schema"."cashbox_history"') IS NOT NULL;
        has_ledger boolean :=
          to_regclass('"finance_schema"."financial_balance_history"') IS NOT NULL;
      BEGIN
        IF to_regclass('"finance_schema"."operator_payments"') IS NULL THEN
          RETURN;
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);

        ALTER TABLE "finance_schema"."operator_payments"
          ADD COLUMN IF NOT EXISTS "source" VARCHAR(16) NOT NULL DEFAULT 'elchi',
          ADD COLUMN IF NOT EXISTS "affects_cashbox" BOOLEAN NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS "paid_at" DATE NULL,
          ADD COLUMN IF NOT EXISTS "recorded_by_role" VARCHAR(32) NULL,
          ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(255) NULL,
          ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "cancelled_by_id" BIGINT NULL,
          ADD COLUMN IF NOT EXISTS "cancelled_by_role" VARCHAR(32) NULL,
          ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT NULL;

        -- Eski qatorlar: sana — yozilgan kunning Toshkent sanasi.
        UPDATE "finance_schema"."operator_payments"
           SET "paid_at" = ("createdAt" AT TIME ZONE 'Asia/Tashkent')::date
         WHERE "paid_at" IS NULL;

        -- Eski (Elchi) qatorlar: kassaga ta'siri — ma'lumotdan. Qayta
        -- yurgizishda ham bir xil natija (faqat 'elchi' qatorlar).
        EXECUTE format(
          $sql$
            UPDATE "finance_schema"."operator_payments" p
               SET "affects_cashbox" = (%s OR %s)
             WHERE p."source" = 'elchi'
          $sql$,
          CASE WHEN has_history THEN
            $cond$EXISTS (
              SELECT 1 FROM "finance_schema"."cashbox_history" h
               WHERE h."source_type"::text = 'salary'
                 AND h."operation_type"::text = 'expense'
                 AND h."source_id" = p."id"
                 AND h."source_user_id" = p."operator_id"
            )$cond$
          ELSE 'false' END,
          CASE WHEN has_ledger THEN
            $cond$EXISTS (
              SELECT 1 FROM "finance_schema"."financial_balance_history" f
               WHERE f."dedup_key" = 'operator-payment:' || p."id"::text
            )$cond$
          ELSE 'false' END
        );

        ALTER TABLE "finance_schema"."operator_payments"
          ALTER COLUMN "paid_at"
            SET DEFAULT ((now() AT TIME ZONE 'Asia/Tashkent'))::date,
          ALTER COLUMN "paid_at" SET NOT NULL;

        ALTER TABLE "finance_schema"."operator_payments"
          DROP CONSTRAINT IF EXISTS "CHK_OPERATOR_PAYMENT_SOURCE",
          DROP CONSTRAINT IF EXISTS "CHK_OPERATOR_PAYMENT_MARKET_NO_CASHBOX",
          DROP CONSTRAINT IF EXISTS "CHK_OPERATOR_PAYMENT_CANCEL";
        ALTER TABLE "finance_schema"."operator_payments"
          ADD CONSTRAINT "CHK_OPERATOR_PAYMENT_SOURCE"
            CHECK ("source" IN ('elchi', 'market')),
          ADD CONSTRAINT "CHK_OPERATOR_PAYMENT_MARKET_NO_CASHBOX"
            CHECK (
              "source" <> 'market'
              OR ("affects_cashbox" = false AND "market_id" IS NOT NULL AND "amount" > 0)
            ),
          ADD CONSTRAINT "CHK_OPERATOR_PAYMENT_CANCEL"
            CHECK (
              "cancelled_at" IS NULL
              OR (
                "source" = 'market'
                AND "cancel_reason" IS NOT NULL
                AND btrim("cancel_reason") <> ''
              )
            );

        CREATE UNIQUE INDEX IF NOT EXISTS "UQ_OPERATOR_PAYMENT_IDEMPOTENCY"
          ON "finance_schema"."operator_payments" ("market_id", "idempotency_key")
          WHERE "idempotency_key" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "IDX_OPERATOR_PAYMENT_MARKET_PAID"
          ON "finance_schema"."operator_payments" ("market_id", "paid_at");

        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"finance_schema"."operator_payments"') IS NULL THEN
          RETURN;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'finance_schema'
             AND table_name = 'operator_payments'
             AND column_name = 'cancelled_at'
        ) THEN
          EXECUTE $sql$
            UPDATE "finance_schema"."operator_payments"
               SET "is_deleted" = true
             WHERE "cancelled_at" IS NOT NULL
          $sql$;
        END IF;

        DROP INDEX IF EXISTS "finance_schema"."UQ_OPERATOR_PAYMENT_IDEMPOTENCY";
        DROP INDEX IF EXISTS "finance_schema"."IDX_OPERATOR_PAYMENT_MARKET_PAID";
        ALTER TABLE "finance_schema"."operator_payments"
          DROP CONSTRAINT IF EXISTS "CHK_OPERATOR_PAYMENT_SOURCE",
          DROP CONSTRAINT IF EXISTS "CHK_OPERATOR_PAYMENT_MARKET_NO_CASHBOX",
          DROP CONSTRAINT IF EXISTS "CHK_OPERATOR_PAYMENT_CANCEL",
          DROP COLUMN IF EXISTS "source",
          DROP COLUMN IF EXISTS "affects_cashbox",
          DROP COLUMN IF EXISTS "paid_at",
          DROP COLUMN IF EXISTS "recorded_by_role",
          DROP COLUMN IF EXISTS "idempotency_key",
          DROP COLUMN IF EXISTS "cancelled_at",
          DROP COLUMN IF EXISTS "cancelled_by_id",
          DROP COLUMN IF EXISTS "cancelled_by_role",
          DROP COLUMN IF EXISTS "cancel_reason";
      END $$;
    `);
  }
}
