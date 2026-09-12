import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders.extra_cost` — kuryer yozgan qo'shimcha xarajat.
 *
 * Ilgari bu summa buyurtmada saqlanmasdi: faqat kassa tarixida
 * (`source_type = EXTRA_COST`) va audit logda qolardi. Ikki oqibati bor edi:
 *
 *   • buyurtmani ko'rib turib qancha xarajat yozilganini bilish uchun kassa
 *     tarixini qazish kerak edi;
 *   • hamkorga (BeePost) u UMUMAN yetib bormasdi — hamkor tomonida market
 *     hech narsa to'lamasdi va ikki daftar shu summaga ajralib qolardi.
 *
 * `DEFAULT 0` — mavjud qatorlar uchun xavfsiz: ular uchun xarajat yozilgan
 * bo'lsa ham endi 0 ko'rinadi. Tarixni kassa tarixidan qayta tiklash
 * MUMKIN, lekin bu alohida ish — bu migratsiya faqat ustunni ochadi.
 */
export class OrderExtraCost1716000000031 implements MigrationInterface {
  name = 'OrderExtraCost1716000000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DB_SCHEMA_ORDER || 'order_schema';
    await queryRunner.query(
      `ALTER TABLE "${schema}"."orders" ` +
        `ADD COLUMN IF NOT EXISTS "extra_cost" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DB_SCHEMA_ORDER || 'order_schema';
    await queryRunner.query(
      `ALTER TABLE "${schema}"."orders" DROP COLUMN IF EXISTS "extra_cost"`,
    );
  }
}
