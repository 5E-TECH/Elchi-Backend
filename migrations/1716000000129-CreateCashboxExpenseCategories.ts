import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Elchi Pochta №1 — kassa xarajatlari kategoriyalari ("To'lovlar → Kassa →
 * xarajat" oynasidagi tanlov ro'yxati).
 *
 *   1. `finance_schema.cashbox_expense_categories` — kategoriyalar. Nom
 *      o'chirilmaganlar orasida noyob (katta-kichik harf farqsiz, partial
 *      unique indeks); o'chirish — SOFT (`is_deleted`), o'chirilgan nom
 *      qayta ishlatilishi mumkin. Superadmin qo'shadi / tahrirlaydi / o'chiradi.
 *   2. Product owner bergan 17 ta kategoriya №-tartibida (`sort_order` 1..17)
 *      SEED qilinadi. Seed idempotent: `ON CONFLICT (lower(name)) DO NOTHING`
 *      — mavjud (o'chirilmagan) bir xil nomli qator qayta yozilmaydi.
 *   3. `finance_schema.cashbox_history.expense_category_id` +
 *      `expense_category_name` — qo'lda chiqim (`PATCH /finance/cashbox/spend`)
 *      qaysi kategoriyaga yozilgani. Nom SNAPSHOT: kategoriya keyin
 *      o'chirilsa yoki qayta nomlansa ham tarix qatori yozilgan paytdagi
 *      nomini ko'rsatadi. Ikkalasi NULL — kategoriyasiz (eski qatorlar va
 *      kategoriya tanlanmagan chiqimlar).
 *
 * ⚠️ Mavjud tarix qatorlari O'ZGARTIRILMAYDI (yangi ustunlar NULL, jadval
 * qayta yozilmaydi).
 */
export const CASHBOX_EXPENSE_CATEGORY_SEED: ReadonlyArray<{
  name: string;
  description: string;
}> = Object.freeze([
  { name: 'Ovqatlanish', description: 'Xodimlarning ovqati, tushlik' },
  { name: "Yoqilg'i", description: 'Benzin, gaz, dizel' },
  {
    name: 'Avtomobil xarajatlari',
    description: "Ta'mirlash, moy almashtirish, ehtiyot qismlar",
  },
  { name: 'Ijara (arenda)', description: 'Filial, ombor, ofis ijarasi' },
  { name: "Kommunal to'lovlar", description: 'Elektr, suv, gaz, chiqindi' },
  { name: 'Internet va aloqa', description: 'Internet, telefon, SIM-karta' },
  { name: 'Xodimlar oyligi', description: 'Oylik, avans, bonus' },
  {
    name: 'Yetkazib berish',
    description: 'Tashqi transport, yuk tashish xizmati',
  },
  {
    name: 'Qadoqlash materiallari',
    description: 'Paket, skotch, quti, yorliq',
  },
  {
    name: 'Ofis xarajatlari',
    description: "Qog'oz, ruchka, printer, kanselyariya",
  },
  {
    name: "Ta'mirlash",
    description: "Filial, ombor va ofis jihozlarini ta'mirlash",
  },
  {
    name: 'Texnika va jihozlar',
    description: 'Kompyuter, printer, skaner, mebel',
  },
  {
    name: 'Reklama va marketing',
    description: 'Telegram, Instagram reklamasi, banner',
  },
  {
    name: 'Xizmat xarajatlari',
    description: 'Bank komissiyasi, dastur obunalari',
  },
  {
    name: "Soliq va majburiy to'lovlar",
    description: 'Soliq, davlat bojlari',
  },
  {
    name: "Tozalik va xo'jalik",
    description: "Tozalash vositalari, xo'jalik buyumlari",
  },
  { name: 'Qaytarilgan pullar', description: 'Mijozga pul qaytarish' },
]);

export class CreateCashboxExpenseCategories1716000000129 implements MigrationInterface {
  name = 'CreateCashboxExpenseCategories1716000000129';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "finance_schema"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."cashbox_expense_categories" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "name" VARCHAR(100) NOT NULL,
        "description" VARCHAR(500) NULL,
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "created_by" BIGINT NULL,
        "updated_by" BIGINT NULL,
        CONSTRAINT "PK_cashbox_expense_categories_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_CASHBOX_EXPENSE_CATEGORY_NAME"
          CHECK (length(btrim("name")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CASHBOX_EXPENSE_CATEGORY_NAME"
        ON "finance_schema"."cashbox_expense_categories" (lower("name"))
        WHERE "is_deleted" = false
    `);

    // Seed — parametrlar bilan (nomlardagi `'` SQL'da qochirilmaydi).
    const params: Array<string | number> = [];
    const rows = CASHBOX_EXPENSE_CATEGORY_SEED.map((category, index) => {
      params.push(category.name, category.description, index + 1);
      const base = index * 3;
      return `($${base + 1}::varchar, $${base + 2}::varchar, $${base + 3}::int)`;
    });
    await queryRunner.query(
      `
      INSERT INTO "finance_schema"."cashbox_expense_categories"
        ("name", "description", "sort_order")
      VALUES ${rows.join(',\n        ')}
      ON CONFLICT ((lower("name"))) WHERE "is_deleted" = false
      DO NOTHING
    `,
      params,
    );

    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        ADD COLUMN IF NOT EXISTS "expense_category_id" BIGINT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        ADD COLUMN IF NOT EXISTS "expense_category_name" VARCHAR(100) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_EXPENSE_CATEGORY"
        ON "finance_schema"."cashbox_history" ("expense_category_id")
        WHERE "expense_category_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_EXPENSE_CATEGORY"`,
    );
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        DROP COLUMN IF EXISTS "expense_category_name"
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        DROP COLUMN IF EXISTS "expense_category_id"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."cashbox_expense_categories"`,
    );
  }
}
