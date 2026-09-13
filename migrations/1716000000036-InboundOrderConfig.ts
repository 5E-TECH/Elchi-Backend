import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `external_integrations.inbound_order_config` — CRM voronkasidan buyurtma
 * yaratish sozlamasi (audit P5/P7/EI-10).
 *
 * NEGA USTUN KERAK. Kiruvchi webhook faqat BIZ jo'natgan posilkaning
 * statusini yangilay olardi. CRM esa teskari ishlaydi: bitim voronkada
 * bosqichdan bosqichga o'tadi va kerakli bosqichga yetganda buyurtma
 * TUG'ILISHI kerak. Voronka/bosqich tushunchasi kodda yo'q edi, shu bois
 * uni saqlaydigan joy ham yo'q.
 *
 * Maydon `NULL` bo'lib qo'shiladi — ya'ni mavjud ulanishlarning xatti-harakati
 * O'ZGARMAYDI. Buyurtma yaratish faqat `enabled: true` va kamida bitta
 * darvoza (`create_on_stages` yoki `create_on_events`) sozlangan ulanishda
 * yoqiladi.
 */
export class InboundOrderConfig1716000000036 implements MigrationInterface {
  name = 'InboundOrderConfig1716000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        ADD COLUMN IF NOT EXISTS "inbound_order_config" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        DROP COLUMN IF EXISTS "inbound_order_config"
    `);
  }
}
