import { MigrationInterface, QueryRunner } from 'typeorm';
import { HQ_BRANCH_REGION_SATO_CODE } from './1716000000204-HqBranchRegion';

/**
 * HQ filialining viloyatini (`branch_schema.branches.region_id`) tiklash
 * (2026-11-17, baza tozalanishi auditi: migratsiya 230 / 231 dagi holatning
 * davomi).
 *
 * Belgisi: Toshkentdagi HQ kuryeriga buyurtma berib bo'lmaydi — «Kuryerga
 * biriktirish» (`POST /orders/assign-to-courier`) va kuryer skani «O'zimga
 * olish» (`POST /orders/scan-assign`) 400 «HQ filialiga viloyat biriktirilmagan
 * — HQ kuryeriga buyurtma berib bo'lmaydi. Administrator HQ filiali viloyatini
 * belgilashi kerak.» (`data.reason: branch_region_missing`) qaytaradi;
 * viloyat id'si yo'q qatorga ishora qilsa — har buyurtma 403
 * `hq_courier_region_only`. Pochtani HQ kuryeriga berish oynasida
 * `is_hq_region: false` — faqat o'z viloyati mos kuryerlar chiqadi.
 *
 * Sabab: HQ viloyatini FAQAT migratsiya 204 yozgan va u «bajarilgan» — qayta
 * yurmaydi. Baza tozalanganda ikki yo'l bilan buziladi:
 *   - HQ qatori o'chgan — branch-service `ensureHqBranch` uni har ishga
 *     tushishda qayta yaratadi, lekin `region_id: NULL` bilan;
 *   - viloyatlar o'chib logistics-service seed'i ularni YANGI id bilan qayta
 *     yaratgan — saqlanib qolgan HQ eski (endi yo'q) id'ga ishora qiladi.
 * Ekrandan tuzatib bo'lmaydi: tahrirlash oynasida viloyat maydoni yo'q,
 * `PATCH /branches/:id` esa HQ'da kuryer bo'lsa viloyat o'zgarishini 409
 * bilan rad etadi (CODE-20).
 *
 * Qoida — faqat HQ viloyati UMUMAN yo'q bo'lsa (o'chirilmagan `type = 'HQ'`
 * qator):
 *   - `region_id` bo'sh YOKI `logistics_schema.regions` da shu id'li qator
 *     umuman yo'q (tozalashda qattiq o'chirilgan) — Toshkent shahri yoziladi
 *     (`HQ_BRANCH_REGION_SATO_CODE`, 204 dagi kabi SOATO bo'yicha: o'chirilmagan,
 *     eng kichik id);
 *   - HQ'da tirik viloyat bor (hatto 1726 bo'lmasa ham — API orqali qo'yilgan
 *     bo'lishi mumkin) yoki u o'chirilgan (`is_deleted`) viloyatga ishora
 *     qiladi (qatori bor — qo'lda qaror bo'lishi mumkin) — tegilmaydi;
 *   - o'chirilgan HQ qatori tiriltirilmaydi, HQ qatori yaratilmaydi (uni
 *     `ensureHqBranch` boshqaradi), boshqa filiallar viloyati tegilmaydi
 *     (ularning to'g'ri viloyati noma'lum — qo'lda);
 *   - 1726 viloyati yo'q bo'lsa — hech narsa qilinmaydi.
 * Bo'sh HQ viloyati admin qarori bo'la olmaydi: ekran uni bo'shata olmaydi,
 * kod esa uni xato sozlama deb hamma HQ kuryer oqimini to'xtatadi; HQ
 * Toshkent shahrida (ega, 2026-11-04).
 *
 * Qayta yurgizish xavfsiz: ikkinchi marta HQ viloyati allaqachon tirik.
 * Jadval(lar) yo'q muhitda — o'tkazib yuboriladi. logistics HQ qatorini har
 * so'rovda (`branch.find_by_id`) o'qiydi — servislarni qayta ishga tushirish
 * shart emas.
 *
 * down(): hech narsa qilmaydi — to'ldirilgan viloyatni qo'lda qo'yilganidan
 * ajratib bo'lmaydi (204 dagi kabi).
 */
export class RestoreHqBranchRegion1716000000233 implements MigrationInterface {
  name = 'RestoreHqBranchRegion1716000000233';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(
      `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
        WHERE (table_schema = 'branch_schema' AND table_name = 'branches')
           OR (table_schema = 'logistics_schema' AND table_name = 'regions')`,
    )) as Array<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>;
    const branchColumns = new Set(
      columns
        .filter((c) => c.table_schema === 'branch_schema')
        .map((c) => c.column_name),
    );
    const regionColumns = new Set(
      columns
        .filter((c) => c.table_schema === 'logistics_schema')
        .map((c) => c.column_name),
    );
    if (!branchColumns.has('region_id') || !regionColumns.has('sato_code')) {
      return;
    }

    await queryRunner.query(
      `UPDATE "branch_schema"."branches" b
          SET "region_id" = target."id"${branchColumns.has('updatedAt') ? ', "updatedAt" = now()' : ''}
         FROM (
           SELECT r."id"
             FROM "logistics_schema"."regions" r
            WHERE r."sato_code" = $1::varchar
              AND r."is_deleted" = false
            ORDER BY r."id"
            LIMIT 1
         ) target
        WHERE b."type"::text = 'HQ'
          AND b."is_deleted" = false
          AND (
            b."region_id" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "logistics_schema"."regions" cur
               WHERE cur."id" = b."region_id"
            )
          )`,
      [HQ_BRANCH_REGION_SATO_CODE],
    );
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh — yuqoridagi izohga qarang.
  }
}
