import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (revMyIKg) O'chirilgan foydalanuvchilarning FAOL filial qatorlarini yopish.
 *
 * Sabab: revMyIKg gacha identity `deleteUser` faqat menejer/registratorning
 * `branch_users` qatorini yopardi (fix3b, `branch.user.remove`), kuryerniki
 * esa `is_deleted = false` bo'lib qolardi (fix3b dan oldin menejer/registrator
 * qatorlari ham). Natija: filial xodimlarida «Noma'lum | Kuryer» qatori,
 * filialni nofaol qilish / turini yoki viloyatini o'zgartirish 409
 * «Filialga N ta kuryer biriktirilgan», filialni o'chirish 409 «N ta faol
 * xodim». Endi deleteUser kuryer qatorini ham yopadi — bu migratsiya ilgari
 * o'chirilganlarning qolgan qatorlarini BIR MARTA tozalaydi.
 *
 * Nimaga tegiladi: faqat `branch_schema.branch_users` dagi `is_deleted =
 * false` qatorlar, egasi `identity_schema.admins` da `is_deleted = true`
 * bo'lsa (har qanday rol: COURIER, MANAGER, REGISTRATOR) — `is_deleted =
 * true`, `updatedAt = now()` (`branch.user.remove` bilan bir xil natija).
 *
 * Nimaga tegilmaydi: faol va nofaol (bloklangan, `status = inactive`)
 * xodimlarning qatorlari; `admins` da umuman yo'q user_id li qatorlar (bu
 * yerda o'chirilgan deb bilib bo'lmaydi); allaqachon yopilgan qatorlar;
 * filiallar, kassa, hisob-kitob, buyurtma va pochtalar — pul harakati yo'q.
 * Yopilgan qatorlar (id, filial, user, rol) migratsiya logiga NOTICE bilan
 * yoziladi.
 *
 * Ikkala `id` ham bigint — cast kerak emas. Qayta yurgizish xavfsiz: ikkinchi
 * marta mos qator yo'q. Jadval(lar) yo'q muhitda — o'tkazib yuboriladi.
 *
 * down(): hech narsa qilmaydi — o'chirilgan foydalanuvchini filialga qaytarish
 * yana «Noma'lum» xodimni tiriltiradi; sxema o'zgarmagan.
 */
export const CLOSE_DELETED_USERS_BRANCH_ROWS_SQL = `
      DO $$
      DECLARE
        closed_count integer;
        closed_rows text;
      BEGIN
        IF to_regclass('"branch_schema"."branch_users"') IS NULL
          OR to_regclass('"identity_schema"."admins"') IS NULL THEN
          RETURN;
        END IF;

        WITH closed AS (
          UPDATE "branch_schema"."branch_users" bu
             SET "is_deleted" = true,
                 "updatedAt" = now()
           WHERE bu."is_deleted" = false
             AND EXISTS (
               SELECT 1 FROM "identity_schema"."admins" a
                WHERE a."id" = bu."user_id"
                  AND a."is_deleted" = true
             )
          RETURNING bu."id", bu."branch_id", bu."user_id", bu."role"
        )
        SELECT count(*)::integer,
               string_agg(
                 format('#%s (filial %s, user %s, %s)', "id", "branch_id", "user_id", "role"),
                 ', ' ORDER BY "id"
               )
          INTO closed_count, closed_rows
          FROM closed;

        RAISE NOTICE 'CloseDeletedUsersBranchRows: % ta branch_users qatori yopildi: %',
          closed_count, COALESCE(closed_rows, '-');
      END
      $$;
    `;

export class CloseDeletedUsersBranchRows1716000000252 implements MigrationInterface {
  name = 'CloseDeletedUsersBranchRows1716000000252';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CLOSE_DELETED_USERS_BRANCH_ROWS_SQL);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh — yuqoridagi izohga qarang.
  }
}
