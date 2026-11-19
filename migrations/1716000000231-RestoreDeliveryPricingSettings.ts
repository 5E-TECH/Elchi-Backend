import { MigrationInterface, QueryRunner } from 'typeorm';
import { DELIVERY_PRICING_SETTINGS_SEED } from './1716000000142-DeliveryPricingEngine';

/**
 * Yetkazish narxi «Hisob qoidalari» — faol sozlama qatorini tiklash
 * (2026-11-17: «Hududlar → Yetkazish tariflari» da «Hisob qoidalarini yuklab
 * bo'lmadi — Yetkazish narxi sozlamalari topilmadi (migratsiya 1716000000142
 * yurgizilmagan?)»; «necha kg dan keyin qo'shimcha haq» (`first_kg_included`)
 * ni kiritib ham, o'zgartirib ham bo'lmaydi).
 *
 * Sabab — migratsiya 230 dagi holat bilan bir xil: baza tozalanganda
 * `logistics_schema.delivery_pricing_settings` qatorlari ketgan, migratsiya 142
 * esa «bajarilgan» bo'lib qolgan — qayta yurmaydi. Tariflar o'sha bazada
 * keyin qo'lda kiritilgan («dastlabki tarif» — 15.11/17.11), sozlamani esa
 * ekrandan tiklab bo'lmaydi: `GET` ham, `PATCH /delivery/pricing-settings`
 * ham faol qatorsiz 409 qaytaradi. Faol sozlamasiz narx hisobi
 * (`quote`, `quote_by_tariff`, `sale_quote`) ham 409 bilan to'xtaydi.
 *
 * Qoida — faqat FAOL (o'chirilmagan) qator UMUMAN bo'lmagan bazada:
 *   - faol qator bor — hech narsa qilinmaydi (admin sozlamasiga tegilmaydi);
 *   - o'chirilmagan, lekin nofaol versiyalar bor — eng so'nggisi (eng katta
 *     `id`) qiymatlari bilan YANGI faol qator yoziladi (tarix o'zgarmaydi,
 *     admin oxirgi kiritgan qiymatlar qaytadi);
 *   - umuman qator yo'q — migratsiya 142 seed'i (hajm bo'luvchisi 5000,
 *     birinchi 1 kg bazada, minimum 0.1 kg, qadam 0.1 kg, 500 ga yaxlitlash,
 *     PICKUP 20 000 / 10+ tekin, express × 1.4); 154 dagi `volumetric_from_kg`
 *     va 183 dagi `min_delivery_price` / `extra_cost_limit_amount` — ustun
 *     sukuti (0 / NULL).
 *   `created_by` NULL (seed kabi) — «O'zgarishlar tarixi»da muallifsiz.
 *
 * Tariflarga (`delivery_tariffs`) tegilmaydi: ular bazada bor (admin kiritgan),
 * 142 seed'i esa `valid_from = 2026-10-08` bilan ularning «hozirgi» versiyasini
 * buzmasa ham tarixni chalkashtirardi.
 *
 * Qayta yurgizish xavfsiz: ikkinchi marta faol qator allaqachon bor.
 * Jadval yo'q muhitda (logistics sxemasi yo'q) — o'tkazib yuboriladi.
 *
 * down(): hech narsa qilmaydi — tiklangan qator keyin admin versiyalari
 * uchun «oldingi versiya» bo'lib qolgan bo'lishi mumkin; sxema o'zgarmagan.
 */
export class RestoreDeliveryPricingSettings1716000000231 implements MigrationInterface {
  name = 'RestoreDeliveryPricingSettings1716000000231';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'logistics_schema'
          AND table_name = 'delivery_pricing_settings'`,
    )) as Array<{ column_name: string }>;
    if (columns.length === 0) {
      return;
    }

    const [{ active }] = (await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM "logistics_schema"."delivery_pricing_settings"
          WHERE "is_active" = true AND "is_deleted" = false
       ) AS active`,
    )) as Array<{ active: boolean }>;
    if (active) {
      return;
    }

    // Qiymat ustunlari — xizmat ustunlarisiz (id, vaqtlar, holat, muallif).
    // Bazadagi haqiqiy ustunlar bo'yicha: 154 / 183 yurmagan muhitda ham ishlaydi.
    const SERVICE_COLUMNS = new Set([
      'id',
      'createdAt',
      'updatedAt',
      'is_deleted',
      'is_active',
      'created_by',
    ]);
    const valueColumns = columns
      .map((c) => c.column_name)
      .filter((name) => !SERVICE_COLUMNS.has(name))
      .sort();
    const quoted = valueColumns.map((name) => `"${name}"`).join(', ');

    const [{ previous }] = (await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM "logistics_schema"."delivery_pricing_settings"
          WHERE "is_deleted" = false
       ) AS previous`,
    )) as Array<{ previous: boolean }>;

    if (previous) {
      await queryRunner.query(
        `INSERT INTO "logistics_schema"."delivery_pricing_settings"
           (${quoted}, "is_active", "created_by")
         SELECT ${quoted}, true, NULL
           FROM "logistics_schema"."delivery_pricing_settings"
          WHERE "is_deleted" = false
          ORDER BY "id" DESC
          LIMIT 1`,
      );
      return;
    }

    const s = DELIVERY_PRICING_SETTINGS_SEED;
    await queryRunner.query(
      `INSERT INTO "logistics_schema"."delivery_pricing_settings"
         ("volumetric_divisor", "first_kg_included", "min_billable_kg",
          "billable_step_kg", "round_to", "pickup_fee", "pickup_free_from_count",
          "express_multiplier", "is_active", "created_by")
       VALUES ($1::int, $2::numeric, $3::numeric, $4::numeric, $5::int,
               $6::numeric, $7::int, $8::numeric, true, NULL)`,
      [
        s.volumetric_divisor,
        s.first_kg_included,
        s.min_billable_kg,
        s.billable_step_kg,
        s.round_to,
        s.pickup_fee,
        s.pickup_free_from_count,
        s.express_multiplier,
      ],
    );
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh — yuqoridagi izohga qarang.
  }
}
