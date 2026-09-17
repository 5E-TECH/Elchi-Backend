import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders.home_branch_id` uchun indeks (audit C4).
 *
 * ⚠️ NEGA KERAK. Filial bo'yicha filtr UCHTA ustun bo'yicha OR qiladi:
 *
 *   branch_id = :id OR holder_branch_id = :id OR home_branch_id = :id
 *
 * Postgres bunday OR'ni faqat HAR BIR shoxda indeks bo'lganda BitmapOr bilan
 * bajaradi. `branch_id` va `holder_branch_id` da indeks bor edi,
 * `home_branch_id` da esa yo'q — ya'ni bitta yetishmagan shox butun rejani
 * `orders` bo'yicha to'liq skanerlashga tushirardi. Bu CRM'dagi eng ko'p
 * ishlatiladigan so'rov (filial manageri o'z buyurtmalarini ko'radi), shuning
 * uchun jadval o'sgani sayin aynan u sekinlashardi.
 *
 * Qisman indeks: o'chirilgan qatorlar hech qachon so'ralmaydi.
 */
export class OrderHomeBranchIndex1716000000044 implements MigrationInterface {
  name = 'OrderHomeBranchIndex1716000000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_HOME_BRANCH"
      ON "order_schema"."orders" ("home_branch_id")
      WHERE "home_branch_id" IS NOT NULL AND "is_deleted" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_ORDERS_HOME_BRANCH"`,
    );
  }
}
