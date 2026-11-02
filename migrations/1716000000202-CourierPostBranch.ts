import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Eski pochtalar (ega qarori 4, 2026-11-02) — QABUL QILINGAN kuryer pochtasi
 * kuryer filialiga bog'lanadi: `logistics_schema.posts.branch_id` =
 * kuryerning filiali (HQ kuryeri — HQ filiali). Shunda filial menejerining
 * «Eski» ro'yxati (`findAllPosts`: `post.branch_id = filial`) o'z kuryerlari
 * pochtalarini ham ko'rsatadi. Kod qabul paytida (`status = RECEIVED`) shu
 * qiymatni yozadi (`syncCourierPostBranch`); bu migratsiya —
 * mavjud qabul qilingan pochtalar uchun BACKFILL.
 *
 * Qaysi qatorlar: `branch_id IS NULL`, haqiqiy kuryerli (`courier_id` 0
 * emas), holati faqat `received`. `sent` (yo'ldagi) kuryer pochtasiga
 * TEGILMAYDI: `branch_id` li SENT pochta filial o'tkazmasi hisoblanadi (HQ →
 * filial dispatch maqsadi, menejerning «Yangi» ro'yxati, `receivePost`
 * buyurtma filialini qayta yozishi). `new` — yig'ilayotgan hudud pochtasi,
 * bekor pochtalarda `branch_id` allaqachon bor.
 *
 * Kuryer filiali — `branch_schema.branch_users` qatorlaridan, faqat ANIQ
 * bo'lganda (aks holda `branch_id` NULL qoladi — noto'g'ri filial abadiy
 * qolardi: kod faqat bo'sh qiymatni to'ldiradi, down() hech narsa qilmaydi).
 * branch-service kuryer avval bo'lgan filialga QAYTGANDA yangi qator
 * yozmaydi — eski o'chirilgan qatorni tiklaydi (`createdAt` eskiligicha), shu
 * bois «`createdAt <= pochta.createdAt` bo'lgan eng oxirgi qator» qoidasi
 * A → B → A da B ni berardi. Qoida:
 *   a) foydalanuvchining HAMMA qatorlari (o'chirilgan ham, istalgan rol) bitta
 *      filialda — o'sha filial. Rol ham hisobga olinadi: tiklashda qator roli
 *      almashadi (`assignUserToBranch`), sobiq COURIER qatori MANAGER bo'lib
 *      qolishi mumkin;
 *   b) aks holda — yagona faol (`is_deleted = false`) qatori COURIER va
 *      `GREATEST(createdAt, updatedAt) <= pochta.createdAt`: qator oxirgi
 *      o'zgarishidan beri uzluksiz faol (tiklash, o'chirish, rol almashishi
 *      — barchasi `repo.save` orqali, `@UpdateDateColumn` `updatedAt` ni
 *      yangilaydi; `branch_users` ga xom UPDATE yo'q) — o'sha filial;
 *   c) qolgan hollarda NULL (noaniq): bunday pochta tarix orqali ochiladi,
 *      faqat menejerning «Eski» ro'yxatida ko'rinmaydi.
 * Kamida bitta COURIER qatori bo'lishi shart (menejer/registrator pochtasi
 * emas).
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
           SET "branch_id" = CASE
                 WHEN s."branch_count" = 1 THEN s."any_branch_id"
                 ELSE s."active_courier_branch_id"
               END
          FROM (
            SELECT u."user_id",
                   COUNT(DISTINCT u."branch_id") AS "branch_count",
                   MIN(u."branch_id") AS "any_branch_id",
                   COUNT(*) FILTER (WHERE NOT u."is_deleted") AS "active_count",
                   MIN(u."branch_id") FILTER (
                     WHERE NOT u."is_deleted"
                       AND upper(u."role"::text) = 'COURIER'
                   ) AS "active_courier_branch_id",
                   MIN(GREATEST(u."createdAt", u."updatedAt")) FILTER (
                     WHERE NOT u."is_deleted"
                       AND upper(u."role"::text) = 'COURIER'
                   ) AS "active_courier_since"
              FROM "branch_schema"."branch_users" u
             GROUP BY u."user_id"
            HAVING bool_or(upper(u."role"::text) = 'COURIER')
          ) s
         WHERE s."user_id" = p."courier_id"
           AND p."branch_id" IS NULL
           AND p."courier_id" IS NOT NULL
           AND p."courier_id" <> 0
           AND p."status"::text = 'received'
           AND (
             -- a) hamma qatorlari bitta filialda
             s."branch_count" = 1
             -- b) yagona faol qator — COURIER, pochtadan oldin beri uzluksiz
             OR (
               s."active_count" = 1
               AND s."active_courier_branch_id" IS NOT NULL
               AND s."active_courier_since" <= p."createdAt"
             )
           );
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh: to'ldirilgan `branch_id` ni koddan yozilganidan ajratib
    // bo'lmaydi (yuqoridagi izoh).
  }
}
