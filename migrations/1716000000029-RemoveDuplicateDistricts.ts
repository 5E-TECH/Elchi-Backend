import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bir xil SOATO ostidagi TAKRORIY tumanlarni tozalash.
 *
 * MUAMMO. `districts` da ikki juft yozuv bir xil joyni ikki marta ifodalardi:
 *
 *   1703236 → "Xo'jaobod" va "Khojaobod"
 *   1724206 → "Oqoltin"   va "Akaltyn"
 *
 * Bu shunchaki chiroyli emaslik masalasi emas. Hamkor (BeePost) SOATO bo'yicha
 * avtomatik moslashganda ikkita nomzoddan BIRINI tanlashga majbur bo'ladi, va
 * qaysi biri tanlangani tasodifga bog'liq. Elchi operatori esa ro'yxatda bir
 * joyni ikki marta ko'radi — posilkalar ikki yozuv orasida bo'linib ketishi
 * mumkin va tuman bo'yicha hisobot ikkiga ajraladi.
 *
 * QAYSI BIRI QOLADI. Hamkor moslamasi allaqachon "Xo'jaobod" va "Oqoltin"ga
 * bog'langan (o'zbekcha imlo), shuning uchun o'shalar qoladi. Seed
 * ma'lumotidan ham takrorlari olib tashlandi — yangi muhitlarda umuman
 * yaratilmaydi.
 *
 * ⚠️ HIMOYA: takroriy yozuv O'CHIRILADI faqat unga HECH NARSA bog'lanmagan
 * bo'lsa. Agar unga buyurtma / filial / foydalanuvchi bog'langan bo'lsa —
 * TEGILMAYDI. Bog'langan yozuvni o'chirish yetkazish manzilini yo'qotardi,
 * bu esa takroriy yozuvdan ancha yomon. Bunday holat `RAISE NOTICE` bilan
 * deploy loglariga chiqadi va qo'lda birlashtirish kerak bo'ladi.
 *
 * Migratsiya qayta ishga tushsa ham xavfsiz: o'chiradigan narsa qolmagan
 * bo'lsa jimgina o'tadi.
 */
export class RemoveDuplicateDistricts1716000000029
  implements MigrationInterface
{
  name = 'RemoveDuplicateDistricts1716000000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orderSchema = process.env.DB_SCHEMA_ORDER || 'order_schema';

    for (const [keep, drop, sato] of [
      ["Xo'jaobod", 'Khojaobod', '1703236'],
      ['Oqoltin', 'Akaltyn', '1724206'],
    ]) {
      const rows = await queryRunner.query(
        `
        SELECT d.id
        FROM "logistics_schema"."districts" d
        WHERE d.name = $1
          AND d.sato_code = $2
          AND EXISTS (
            SELECT 1 FROM "logistics_schema"."districts" k
            WHERE k.name = $3 AND k.sato_code = $2
          )
        `,
        [drop, sato, keep],
      );
      if (!rows?.length) continue;

      const dropId = String(rows[0].id);

      /**
       * Bog'lanish tekshiruvi. `district_id` mantiqiy bog'lanish (fizik FK
       * yo'q), shuning uchun ON DELETE bizni himoya qilmaydi — o'zimiz
       * tekshiramiz.
       */
      const [{ refs }] = await queryRunner.query(
        `
        SELECT (
          (SELECT COUNT(*) FROM "${orderSchema}"."orders"      WHERE district_id = $1) +
          (SELECT COUNT(*) FROM "branch_schema"."branches"     WHERE district_id = $1) +
          (SELECT COUNT(*) FROM "identity_schema"."admins"     WHERE district_id = $1)
        )::int AS refs
        `,
        [dropId],
      );

      if (refs > 0) {
        // `DO $$ ... $$` PARAMETR QABUL QILMAYDI — u yerda `$1` yozish
        // migratsiyani yiqitardi, migratsiya yiqilsa esa BUTUN DEPLOY
        // to'xtaydi (`--abort-on-container-exit`). Shu bois oddiy Node logi.
        console.warn(
          `[RemoveDuplicateDistricts] ${drop} (id=${dropId}) takroriy, ` +
            `lekin ${refs} ta yozuv bog'langan — TEGILMADI. ` +
            `Qo'lda "${keep}" bilan birlashtirish kerak.`,
        );
        continue;
      }

      await queryRunner.query(
        `DELETE FROM "logistics_schema"."districts" WHERE id = $1`,
        [dropId],
      );
    }
  }

  public async down(): Promise<void> {
    /**
     * ATAYLAB BO'SH. Takroriy yozuvni QAYTA yaratish hech narsani tuzatmaydi —
     * u boshlanishidan xato edi va yangi id bilan tiklansa, eski id'ga
     * tayangan har qanday tashqi moslama baribir buziladi.
     */
  }
}
