import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Takroriy tumanni BIRLASHTIRISH (oldingi migratsiya faqat o'chira olardi).
 *
 * `1716000000029` bog'lanmagan takrorlarni o'chirdi, lekin bog'langanlariga
 * ataylab tegmadi. Amalda `1724206` uchun aynan shu holat chiqdi:
 *
 *   #149 "Oqoltin"  ← to'g'ri o'zbekcha nom, hamkor moslamasi shunga bog'langan
 *   #145 "Akaltyn"  ← ruscha transliteratsiya, LEKIN unga yozuvlar bog'langan
 *
 * Shuning uchun o'chirish YETARLI EMAS — avval bog'lanishlarni ko'chirish
 * kerak. Bu xavfsiz: ikkala yozuv AYNI joyni bildiradi (SOATO bir xil),
 * shuning uchun buyurtmaning yetkazish manzili O'ZGARMAYDI, faqat u endi
 * yagona, to'g'ri nomli yozuvga ishora qiladi.
 *
 * NEGA UMUMAN MUHIM. Takror qolsa: Elchi operatori ro'yxatda bir joyni ikki
 * marta ko'radi, tuman bo'yicha hisobot ikkiga bo'linadi, va hamkorning
 * avtomatik moslashi ikki nomzoddan birini tanlashga majbur bo'ladi.
 *
 * XAVFSIZLIK:
 *   • Faqat ikkala yozuv ham mavjud VA SOATO'lari bir xil bo'lsa ishlaydi —
 *     aks holda bu boshqa joylar bo'lardi va birlashtirish ma'lumot yo'qotardi.
 *   • Qayta ishga tushirishga chidamli: birlashtiriladigan narsa qolmasa
 *     jimgina o'tadi.
 */
export class MergeDuplicateDistricts1716000000030
  implements MigrationInterface
{
  name = 'MergeDuplicateDistricts1716000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orderSchema = process.env.DB_SCHEMA_ORDER || 'order_schema';

    /** [saqlanadigan nom, o'chiriladigan nom, umumiy SOATO] */
    const PAIRS: Array<[string, string, string]> = [
      ['Oqoltin', 'Akaltyn', '1724206'],
      ["Xo'jaobod", 'Khojaobod', '1703236'],
    ];

    for (const [keep, drop, sato] of PAIRS) {
      const rows = await queryRunner.query(
        `
        SELECT
          (SELECT id FROM "logistics_schema"."districts"
            WHERE name = $1 AND sato_code = $3 LIMIT 1) AS keep_id,
          (SELECT id FROM "logistics_schema"."districts"
            WHERE name = $2 AND sato_code = $3 LIMIT 1) AS drop_id
        `,
        [keep, drop, sato],
      );

      const keepId = rows?.[0]?.keep_id;
      const dropId = rows?.[0]?.drop_id;

      // Biri yo'q bo'lsa birlashtiradigan narsa ham yo'q (yoki allaqachon
      // bajarilgan). Bu xato emas.
      if (!keepId || !dropId || String(keepId) === String(dropId)) continue;

      /**
       * Bog'lanishlarni ko'chirish. `district_id` MANTIQIY bog'lanish (fizik
       * FK yo'q), shuning uchun har bir jadval alohida yangilanadi — kaskad
       * bizni qutqarmaydi.
       */
      for (const table of [
        `"${orderSchema}"."orders"`,
        `"branch_schema"."branches"`,
        `"identity_schema"."admins"`,
      ]) {
        await queryRunner.query(
          `UPDATE ${table} SET district_id = $1 WHERE district_id = $2`,
          [keepId, dropId],
        );
      }

      await queryRunner.query(
        `DELETE FROM "logistics_schema"."districts" WHERE id = $1`,
        [dropId],
      );

      console.warn(
        `[MergeDuplicateDistricts] ${drop} (id=${dropId}) -> ${keep} ` +
          `(id=${keepId}) birlashtirildi, SOATO ${sato}`,
      );
    }
  }

  public async down(): Promise<void> {
    /**
     * ATAYLAB BO'SH. Qaytarish uchun "qaysi yozuv avval takrorga tegishli
     * edi" ma'lumoti kerak, u esa saqlanmaydi. Takrorni qayta yaratish
     * boshidanoq xato bo'lgan holatni tiklardi.
     */
  }
}
