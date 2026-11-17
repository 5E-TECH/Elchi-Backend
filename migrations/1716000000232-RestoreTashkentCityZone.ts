import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CITY_ZONE_FALLBACK_NAMES,
  CITY_ZONE_SATO_CODE,
} from './1716000000142-DeliveryPricingEngine';

/**
 * Toshkent shahri «shahar zonasi» belgisini (`regions.is_city_zone`) tiklash
 * (2026-11-17, baza tozalanishi auditi: migratsiya 230 / 231 dagi holatning
 * davomi).
 *
 * Belgi — ko'rinmas, lekin narxga ta'sir qiladi: yetkazish `city` tarifi
 * (seed: 35 000 + 4 000/kg, 1 kun) faqat yo'nalishning IKKALA uchi ham shahar
 * zonasida bo'lsa tanlanadi (`resolveDeliveryTariffId`). Belgi yo'q bo'lsa
 * Toshkent shahri ichidagi yetkazish ham jimgina «center» (40 000) yoki
 * «address» (60 000 + 5 000/kg) bilan hisoblanadi, `city_route: false`;
 * xato chiqmaydi. Ta'sir: elchipochta.uz kalkulyatori
 * (`POST /public/delivery-quote`, `GET /public/delivery-tariffs` —
 * barcha viloyatda `is_city_zone: false`), `POST /delivery/quote`, hamkor
 * `GET /partner/tariff` (`sale_quote`) va `SALE_PRICING_ENGINE=on` bo'lsa
 * sotuvdagi qo'shimcha.
 *
 * Sabab: belgini FAQAT migratsiya 142 qo'yadi va faqat ustunni qo'shgan
 * yurishida (keyin qayta yurmaydi — «bajarilgan»). Baza tozalanib viloyatlar
 * o'chganda ularni logistics-service `onModuleInit` seed'i qayta yaratadi,
 * lekin faqat `name` + `sato_code` bilan — `is_city_zone` ustun sukuti
 * (`false`) bo'lib qoladi. Belgini hech bir API / ekran yoza olmaydi
 * (`CreateRegionDto` / `UpdateRegionDto` da maydon yo'q), shuning uchun uni
 * ekrandan tuzatib bo'lmaydi.
 *
 * Qoida — faqat shahar zonasi UMUMAN bo'lmagan bazada (seed belgisi:
 * `is_city_zone = true` qator, o'chirilgani ham):
 *   - birorta qatorda belgi bor — hech narsa qilinmaydi (142 seed'i saqlangan
 *     yoki zona SQL bilan ataylab boshqa qatorga qo'yilgan — ustidan
 *     yozilmaydi);
 *   - aks holda 142 dagi tanlov bilan (`CITY_ZONE_SATO_CODE` /
 *     `CITY_ZONE_FALLBACK_NAMES`) faqat O'CHIRILMAGAN qatorga belgi qo'yiladi:
 *     SOATO `1726` (Toshkent SHAHRI); SOATO'li 1726 qatori yo'q bo'lsagina —
 *     SOATO'siz qator aniq nom bilan. Nom prefiksi ("Toshkent%") bilan
 *     qidirilmaydi: prod'da Toshkent VILOYATI qatori `Toshkent` (SOATO 1727)
 *     deb nomlangan va u shahar zonasi EMAS (ega qarori, 142 izohi).
 *   Belgi hammasi `false` holati faqat qayta seed'dan keyin bo'ladi (ilovada
 *   belgini o'chiradigan yo'l yo'q), shuning uchun bu admin qarorini
 *   qaytarmaydi.
 *
 * Viloyat qatorlarining o'ziga tegilmaydi (ularni seed tiklaydi), logist
 * biriktiruvi (`logist_id`) va tuman qayta biriktiruvlari tiklanmaydi —
 * ular admin qarori, ekrandan qayta qilinadi (`/regions/logist-assignment`,
 * «Hududlar»).
 *
 * Qayta yurgizish xavfsiz: ikkinchi marta zona allaqachon bor. Jadval yoki
 * ustun yo'q muhitda (logistics sxemasi yo'q / 142 yurmagan) — o'tkazib
 * yuboriladi. Bo'sh bazada (`db:prepare`) viloyatlar migratsiyalardan KEYIN
 * yaratiladi — bu migratsiya u yerda hech narsa qilmaydi.
 *
 * down(): hech narsa qilmaydi — belgini qaytarib olish narxni yana jimgina
 * buzadi; sxema o'zgarmagan.
 */
export class RestoreTashkentCityZone1716000000232 implements MigrationInterface {
  name = 'RestoreTashkentCityZone1716000000232';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'logistics_schema'
          AND table_name = 'regions'`,
    )) as Array<{ column_name: string }>;
    const has = new Set(columns.map((c) => c.column_name));
    if (!has.has('is_city_zone') || !has.has('sato_code')) {
      return;
    }

    const [{ seeded }] = (await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM "logistics_schema"."regions"
          WHERE "is_city_zone" = true
       ) AS seeded`,
    )) as Array<{ seeded: boolean }>;
    if (seeded) {
      return;
    }

    await queryRunner.query(
      `UPDATE "logistics_schema"."regions" r
          SET "is_city_zone" = true${has.has('updatedAt') ? ', "updatedAt" = now()' : ''}
        WHERE r."is_deleted" = false
          AND (
            r."sato_code" = $1::varchar
            OR (
              r."sato_code" IS NULL
              AND lower(btrim(r."name")) = ANY ($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM "logistics_schema"."regions" s
                 WHERE s."sato_code" = $1::varchar
                   AND s."is_deleted" = false
              )
            )
          )`,
      [CITY_ZONE_SATO_CODE, [...CITY_ZONE_FALLBACK_NAMES]],
    );
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh — yuqoridagi izohga qarang.
  }
}
