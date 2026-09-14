import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders(external_id, operator)` — tashqi buyurtma dublikat tekshiruvi uchun.
 *
 * MUAMMO (audit EI-11). `receiveExternalOrders` har bir kelgan yozuv uchun
 * `findOne({ external_id, operator })` qiladi — dublikatni o'tkazib
 * yubormaslik uchun. Lekin bu ustunlarda INDEKS YO'Q edi, ya'ni har qator
 * uchun `orders` jadvali TO'LIQ skanerlanardi. 50 ta buyurtma import
 * qilinsa — 50 marta to'liq skanerlash.
 *
 * ⚠️ INDEKS UNIQUE EMAS va bu ataylab:
 *   • `external_id` NULL bo'lishi mumkin (tashqi manba id bermasa);
 *   • mavjud ma'lumotda dublikat bo'lishi mumkin va `UNIQUE` migratsiya
 *     deploy'ni yiqitardi.
 * Dublikat himoyasi kodda qoladi (`findOne` tekshiruvi), indeks esa uni
 * TEZ qiladi.
 *
 * `WHERE external_id IS NOT NULL` — qismiy indeks: ichki buyurtmalar
 * (ular ko'pchilik) indeksga tushmaydi va u kichik qoladi.
 *
 * `CONCURRENTLY` ISHLATILMAYDI: u tranzaksiya ichida ishlamaydi, TypeORM
 * migratsiyalari esa tranzaksiyada bajariladi. Jadval katta bo'lsa qisqa
 * qulflanish bo'ladi — buni deploy oynasida hisobga olish kerak.
 */
export class ExternalOrderLookupIndex1716000000035
  implements MigrationInterface
{
  name = 'ExternalOrderLookupIndex1716000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDER_EXTERNAL_LOOKUP"
        ON "order_schema"."orders" ("external_id", "operator")
        WHERE "external_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."IDX_ORDER_EXTERNAL_LOOKUP"
    `);
  }
}
