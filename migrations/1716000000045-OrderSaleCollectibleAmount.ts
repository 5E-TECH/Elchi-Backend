import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders.sale_collectible_amount` — sotuvda yig'ilgan naqdning snapshoti.
 *
 * ⚠️ NEGA KERAK. Kassa matematikasi shu paytgacha `total_price` ga tayangan,
 * ya'ni "mijoz qancha to'lasa, kuryer shuncha naqd yig'di" deb hisoblagan.
 * Mijoz onlayn to'lagan (yoki hamkor `cod_amount: 0` bilan prepaid posilka
 * yuborgan) holatda bu YOLG'ON: naqd yo'q, formulalar esa o'zgarmaydi.
 *
 * Endi naqd oyoqlari `total_price − paid_online_amount` bo'yicha yoziladi va
 * o'sha qiymat shu ustunga SNAPSHOT qilinadi.
 *
 * ⚠️ NEGA SNAPSHOT. Rollback sotuvni aynan teskari yozishi kerak, lekin
 * `paid_online_amount` sotuvdan keyin ham o'zgaradi (qaytarish webhooki uni
 * kamaytiradi). Qayta hisoblansa rollback boshqa summani teskari yozardi va
 * kassada farq qolardi. `courier_share` va `branch_cashbox_amount` aynan shu
 * sababdan snapshot qilingan — bu ustun o'sha naqshni davom ettiradi.
 *
 * `NULL` — sotilmagan yoki bu ustundan oldin sotilgan buyurtma. Rollback
 * bunda `total_price` ga qaytadi, ya'ni eski ma'lumot xuddi bugungidek
 * ishlaydi. Shu bois `DEFAULT` ham, backfill ham ATAYLAB qilinmaydi:
 * 0 bilan to'ldirish eski sotuvlarni "naqd yig'ilmagan" deb ko'rsatib,
 * rollback'da kassani buzardi.
 */
export class OrderSaleCollectibleAmount1716000000045 implements MigrationInterface {
  name = 'OrderSaleCollectibleAmount1716000000045';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "sale_collectible_amount" numeric(14,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      DROP COLUMN IF EXISTS "sale_collectible_amount"
    `);
  }
}
