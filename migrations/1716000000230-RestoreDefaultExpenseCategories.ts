import { MigrationInterface, QueryRunner } from 'typeorm';
import { CASHBOX_EXPENSE_CATEGORY_SEED } from './1716000000129-CreateCashboxExpenseCategories';
import { SEED_LEDGER_CATEGORY_BY_NAME } from './1716000000197-FinancialExpenseCategory';

/**
 * Kassa xarajati kategoriyalari — STANDART 17 ta kategoriyani tiklash
 * (prod 2026-11-15: «xarajatlar kategoriyasi chiqmayapti»).
 *
 * Prod'da `finance_schema.cashbox_expense_categories` da migratsiya 129
 * seed'idan birorta qator yo'q: 2026-11-14 da superadmin qo'shgan birinchi
 * kategoriya `id = 1` oldi, ya'ni jadval o'shanda bo'sh edi (baza tozalanganda
 * jadval qatorlari ketgan, migratsiya 129 esa «bajarilgan» bo'lib qolgan —
 * qayta yurmaydi). Natija: «Kassadan xarajat» tanlovi bo'sh, kategoriya esa
 * MAJBURIY — asosiy kassadan chiqim qilib bo'lmaydi.
 *
 * Qoida — faqat seed UMUMAN bo'lmagan bazada:
 *   - standart qator (`is_default = true` yoki `created_by IS NULL` —
 *     migratsiya 214 bilan bir xil belgi) birortasi bo'lsa, o'chirilgani ham —
 *     hech narsa qilinmaydi (seed bo'lgan; superadmin 11-11 gacha ataylab
 *     o'chirganlari qayta tirilmaydi — test bazasidagi holat);
 *   - aks holda 129 dagi 17 ta kategoriya PO tartibida (`sort_order` 1..17),
 *     197 dagi `ledger_category` bog'lanishi va 214 dagi `is_default = true`
 *     bilan qo'shiladi; `created_by` NULL (seed kabi).
 *   - superadmin shu nomda FAOL kategoriya qo'shgan bo'lsa, o'sha seed qatori
 *     tashlab ketiladi (noyob nom, `ON CONFLICT DO NOTHING`), uning qatoriga
 *     tegilmaydi.
 *
 * Pulga va tarixga (`cashbox_history`) tegilmaydi. Qayta yurgizish xavfsiz
 * (ikkinchi marta seed allaqachon bor — hech narsa qilmaydi).
 *
 * down(): hech narsa qilmaydi — qo'shilgan kategoriyalar tarix qatorlarida
 * ishlatilgan bo'lishi mumkin; ularni o'chirish (yoki qoldirish) zararsiz
 * ma'lumot qarori, sxema o'zgarmagan.
 */
export class RestoreDefaultExpenseCategories1716000000230 implements MigrationInterface {
  name = 'RestoreDefaultExpenseCategories1716000000230';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'finance_schema'
          AND table_name = 'cashbox_expense_categories'`,
    )) as Array<{ column_name: string }>;
    if (columns.length === 0) {
      return;
    }
    const has = new Set(columns.map((c) => c.column_name));
    const withDefault = has.has('is_default');
    const withLedger = has.has('ledger_category');

    const [{ seeded }] = (await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM "finance_schema"."cashbox_expense_categories"
          WHERE "created_by" IS NULL${withDefault ? ' OR "is_default" = true' : ''}
       ) AS seeded`,
    )) as Array<{ seeded: boolean }>;
    if (seeded) {
      return;
    }

    const insertColumns = ['"name"', '"description"', '"sort_order"'];
    if (withLedger) insertColumns.push('"ledger_category"');
    if (withDefault) insertColumns.push('"is_default"');

    const params: Array<string | number | null> = [];
    const rows = CASHBOX_EXPENSE_CATEGORY_SEED.map((category, index) => {
      const values: string[] = [];
      const add = (value: string | number | null, cast: string) => {
        params.push(value);
        values.push(`$${params.length}::${cast}`);
      };
      add(category.name, 'varchar');
      add(category.description, 'varchar');
      add(index + 1, 'int');
      if (withLedger) {
        add(
          SEED_LEDGER_CATEGORY_BY_NAME[category.name] ?? null,
          '"finance_schema"."expense_category_enum"',
        );
      }
      if (withDefault) values.push('true');
      return `(${values.join(', ')})`;
    });

    await queryRunner.query(
      `
      INSERT INTO "finance_schema"."cashbox_expense_categories"
        (${insertColumns.join(', ')})
      VALUES ${rows.join(',\n        ')}
      ON CONFLICT ((lower("name"))) WHERE "is_deleted" = false
      DO NOTHING
    `,
      params,
    );
  }

  public async down(): Promise<void> {
    // Ma'lumot migratsiyasi: qaytarishda kategoriyalar o'chirilmaydi (yuqoridagi izoh).
  }
}
