import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ljVOuNz4 — chiqimda "nima uchun?": P&L daftarida xarajat kategoriyasi.
 *
 *  1. PG enum `finance_schema.expense_category_enum` — yopiq 18 ta qiymat
 *     (`ExpenseCategory`, `libs/common/enums`).
 *  2. `financial_balance_history.expense_category` (nullable) + partial
 *     indeks. Eski qatorlar NULL qoladi: ular haqiqatan noma'lum, "Boshqa"
 *     deb bo'yalmaydi (hisobotda «Kategoriyasiz» AYRIM chiqadi).
 *  3. `cashbox_expense_categories.ledger_category` (nullable) — kassa
 *     ro'yxati superadmin qo'lida (nomlari erkin, migratsiya 129), daftar va
 *     hisobot esa yopiq ro'yxatda: qo'lda kassa chiqimining daftar qatori shu
 *     ustundan oladi. Seed'dagi nomlar bog'lanadi; mos kelmaganlari
 *     (`Texnika va jihozlar`, `Qaytarilgan pullar`, superadmin qo'shganlari)
 *     NULL — servis ularni `other` deb yozadi.
 *
 * Mavjud qatorlar qayta yozilmaydi (`cashbox_history` ga umuman tegilmaydi),
 * pulga tegmaydi. `lock_timeout` 5 s (187 dagidek). Qayta yurgizish xavfsiz.
 *
 * down(): indeks, ikkala ustun va enum turi o'chiriladi.
 */
export const EXPENSE_CATEGORY_ENUM_VALUES: readonly string[] = Object.freeze([
  'food',
  'transport',
  'fuel',
  'rent',
  'utilities',
  'communication',
  'stationery',
  'repair',
  'marketing',
  'tax',
  'bank_fee',
  'gift',
  'cleaning',
  'packaging',
  'salary',
  'courier_fee',
  'vehicle_repair',
  'other',
]);

/** Migratsiya 129 seed'i → yopiq ro'yxat (faqat ma'nosi aniq mos kelganlari). */
export const SEED_LEDGER_CATEGORY_BY_NAME: Readonly<Record<string, string>> =
  Object.freeze({
    Ovqatlanish: 'food',
    "Yoqilg'i": 'fuel',
    'Avtomobil xarajatlari': 'vehicle_repair',
    'Ijara (arenda)': 'rent',
    "Kommunal to'lovlar": 'utilities',
    'Internet va aloqa': 'communication',
    'Xodimlar oyligi': 'salary',
    'Yetkazib berish': 'transport',
    'Qadoqlash materiallari': 'packaging',
    'Ofis xarajatlari': 'stationery',
    "Ta'mirlash": 'repair',
    'Reklama va marketing': 'marketing',
    'Xizmat xarajatlari': 'bank_fee',
    "Soliq va majburiy to'lovlar": 'tax',
    "Tozalik va xo'jalik": 'cleaning',
  });

const ENUM_LABELS_SQL = EXPENSE_CATEGORY_ENUM_VALUES.map(
  (value) => `'${value}'`,
).join(', ');

export class FinancialExpenseCategory1716000000197 implements MigrationInterface {
  name = 'FinancialExpenseCategory1716000000197';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
      BEGIN
        IF to_regclass('finance_schema.financial_balance_history') IS NULL THEN
          RETURN;
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'finance_schema'
            AND t.typname = 'expense_category_enum'
        ) THEN
          CREATE TYPE "finance_schema"."expense_category_enum"
            AS ENUM (${ENUM_LABELS_SQL});
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);
        ALTER TABLE "finance_schema"."financial_balance_history"
          ADD COLUMN IF NOT EXISTS "expense_category"
            "finance_schema"."expense_category_enum";
        CREATE INDEX IF NOT EXISTS "IDX_FBH_EXPENSE_CATEGORY"
          ON "finance_schema"."financial_balance_history" ("expense_category")
          WHERE "expense_category" IS NOT NULL;
        IF to_regclass('finance_schema.cashbox_expense_categories') IS NOT NULL THEN
          ALTER TABLE "finance_schema"."cashbox_expense_categories"
            ADD COLUMN IF NOT EXISTS "ledger_category"
              "finance_schema"."expense_category_enum";
        END IF;
        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
      END $$;
    `);

    const [{ t: categories }] = (await queryRunner.query(
      `SELECT to_regclass('finance_schema.cashbox_expense_categories') AS t`,
    )) as Array<{ t: string | null }>;
    if (!categories) {
      return;
    }
    // Nom bo'yicha (katta-kichik harf farqsiz); o'chirilgani ham — tarixdagi
    // qatorlar hisobotda bog'lanadi. Qo'lda qo'yilgan qiymat bosilmaydi.
    for (const [name, category] of Object.entries(
      SEED_LEDGER_CATEGORY_BY_NAME,
    )) {
      await queryRunner.query(
        `
        UPDATE "finance_schema"."cashbox_expense_categories"
        SET "ledger_category" = $1::"finance_schema"."expense_category_enum"
        WHERE lower("name") = lower($2) AND "ledger_category" IS NULL
      `,
        [category, name],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_FBH_EXPENSE_CATEGORY"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('finance_schema.cashbox_expense_categories') IS NOT NULL THEN
          ALTER TABLE "finance_schema"."cashbox_expense_categories"
            DROP COLUMN IF EXISTS "ledger_category";
        END IF;
        IF to_regclass('finance_schema.financial_balance_history') IS NOT NULL THEN
          ALTER TABLE "finance_schema"."financial_balance_history"
            DROP COLUMN IF EXISTS "expense_category";
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "finance_schema"."expense_category_enum"`,
    );
  }
}
