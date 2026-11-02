import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Eski pochtalar (ega qarori 4, 2026-11-02) — QABUL QILINGAN kuryer pochtasi
 * kuryer filialiga bog'lanadi: `logistics_schema.posts.branch_id` =
 * kuryerning filiali (HQ kuryeri — HQ filiali). Shunda filial menejerining
 * «Eski» ro'yxati (`findAllPosts`: `post.branch_id = filial`) o'z kuryerlari
 * pochtalarini ham ko'rsatadi. Kod qabul paytida (`status = RECEIVED`) shu
 * qiymatni yozadi (`fillCourierPostBranchOnReceive`); bu migratsiya —
 * mavjud qabul qilingan pochtalar uchun BACKFILL.
 *
 * Qaysi qatorlar: `branch_id IS NULL`, haqiqiy kuryerli (`courier_id` 0
 * emas), holati faqat `received`. `sent` (yo'ldagi) kuryer pochtasiga
 * TEGILMAYDI: `branch_id` li SENT pochta filial o'tkazmasi hisoblanadi (HQ →
 * filial dispatch maqsadi, menejerning «Yangi» ro'yxati, `receivePost`
 * buyurtma filialini qayta yozishi). `new` — yig'ilayotgan hudud pochtasi,
 * bekor pochtalarda `branch_id` allaqachon bor.
 *
 * Kuryer filiali — `branch_schema.branch_users` dagi COURIER biriktiruvi,
 * pochta YARATILGAN paytdagisi: `createdAt <= pochta.createdAt` bo'lgan eng
 * oxirgi biriktiruv (kuryer A filialdan B ga o'tgan bo'lsa, A davridagi
 * pochtalar A da qoladi). Bunday biriktiruv bo'lmasa — avval faol
 * (`is_deleted = false`), u bo'lmasa eng oxirgi biriktiruv.
 *
 * XAVFSIZLIK: pulga va buyurtmalarga tegmaydi, faqat bo'sh `branch_id`
 * to'ldiriladi — qayta yurgizish xatosiz (ikkinchi marta hech narsa
 * o'zgarmaydi). Jadval(lar) bo'lmasa — o'tkazib yuboriladi. down(): qaysi
 * qator migratsiya bilan to'ldirilgani saqlanmaydi (kod ham shu qiymatni
 * yozadi), shuning uchun hech narsa qilmaydi.
 */
export class CourierPostBranch1716000000202 implements MigrationInterface {
  name = 'CourierPostBranch1716000000202';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"logistics_schema"."posts"') IS NULL
          OR to_regclass('"branch_schema"."branch_users"') IS NULL THEN
          RETURN;
        END IF;
        UPDATE "logistics_schema"."posts" p
           SET "branch_id" = COALESCE(
                 (SELECT u."branch_id"
                    FROM "branch_schema"."branch_users" u
                   WHERE u."user_id" = p."courier_id"
                     AND upper(u."role"::text) = 'COURIER'
                     AND u."createdAt" <= p."createdAt"
                   ORDER BY u."createdAt" DESC, u."id" DESC
                   LIMIT 1),
                 (SELECT u."branch_id"
                    FROM "branch_schema"."branch_users" u
                   WHERE u."user_id" = p."courier_id"
                     AND upper(u."role"::text) = 'COURIER'
                   ORDER BY u."is_deleted" ASC,
                            u."createdAt" DESC,
                            u."id" DESC
                   LIMIT 1)
               )
         WHERE p."branch_id" IS NULL
           AND p."courier_id" IS NOT NULL
           AND p."courier_id" <> 0
           AND p."status"::text = 'received'
           AND EXISTS (
             SELECT 1
               FROM "branch_schema"."branch_users" u
              WHERE u."user_id" = p."courier_id"
                AND upper(u."role"::text) = 'COURIER'
           );
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh: to'ldirilgan `branch_id` ni koddan yozilganidan ajratib
    // bo'lmaydi (yuqoridagi izoh).
  }
}
