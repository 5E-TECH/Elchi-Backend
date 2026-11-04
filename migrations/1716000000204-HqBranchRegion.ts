import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * anKpzwxk (ega qarori 4, 2026-11-03): «HQ kuryerlari faqat HQ joylashgan
 * viloyat buyurtmalarini oladi». Qoida HQ filialining viloyatini
 * (`branch_schema.branches.region_id`) o'qiydi, viloyat bo'sh bo'lsa HQ
 * kuryeriga hech narsa berilmaydi (400 `branch_region_missing`). HQ esa
 * branch-service `ensureHqBranch` da viloyatsiz yaratiladi va admin UI uni
 * belgilay olmaydi — prod va test serverda HQ viloyati bo'sh.
 *
 * HQ Toshkent shahrida joylashgan (ega, 2026-11-04). Shu migratsiya viloyati
 * BO'SH HQ filialiga Toshkent shahrini (SOATO 1726 — 1716000000142 dagi kabi
 * kod bo'yicha) yozadi.
 *
 * XAVFSIZLIK: faqat bo'sh `region_id` to'ldiriladi — qo'lda qo'yilgan
 * viloyat ustidan yozilmaydi; qayta yurgizish hech narsani o'zgartirmaydi.
 * Jadval(lar) yoki 1726 viloyati bo'lmasa — hech narsa qilinmaydi.
 * down(): qaysi qator shu migratsiya bilan to'ldirilgani saqlanmaydi, shuning
 * uchun hech narsa qilmaydi.
 *
 * Bo'sh bazada (`db:prepare`) HQ migratsiyalardan KEYIN (branch-service
 * ishga tushganda) yaratiladi — u yerda HQ viloyati qo'lda beriladi.
 */
export class HqBranchRegion1716000000204 implements MigrationInterface {
  name = 'HqBranchRegion1716000000204';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"branch_schema"."branches"') IS NULL
          OR to_regclass('"logistics_schema"."regions"') IS NULL THEN
          RETURN;
        END IF;
        UPDATE "branch_schema"."branches" b
           SET "region_id" = r."id"
          FROM (
            SELECT "id"
              FROM "logistics_schema"."regions"
             WHERE "sato_code" = '1726'
               AND "is_deleted" = false
             ORDER BY "id"
             LIMIT 1
          ) r
         WHERE b."type"::text = 'HQ'
           AND b."is_deleted" = false
           AND b."region_id" IS NULL;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh: to'ldirilgan `region_id` ni qo'lda qo'yilganidan
    // ajratib bo'lmaydi (yuqoridagi izoh).
  }
}
