import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (pe71yf8L) Foydalanuvchi faolligi: oxirgi kirish va oxirgi faollik vaqti.
 *
 * Dilshod (2026-11-27): «marketlarni qachon kirganini va hozir online yoki
 * offline ligini ham ko'rinadigan qilsa bo'ladimi». Shu vaqtgacha oxirgi
 * kirish faqat `user_sessions` qatorlarida edi — ular muddatidan 90 kun
 * keyin soatlik tozalashda o'chiriladi (`AuthSessionService.cleanup`), uzoq
 * kirmagan marketning oxirgi kirishi yo'qolardi. Endi har foydalanuvchiga
 * BITTA qator, o'chirilmaydi:
 *  - `last_login_at` — oxirgi login (parol / SMS kod), sessiya qayta
 *    ishlatilganda ham;
 *  - `last_seen_at` — oxirgi faollik: login, refresh (soatda ~1 marta) va
 *    gateway `/realtime` socketining ulanishi / uzilishi.
 * Yozish faqat `GREATEST` bilan (vaqt orqaga ketmaydi), `admins` qatoriga
 * tegilmaydi (`updatedAt` o'zgarmaydi, `sanitize` orqali boshqa
 * endpointlarga chiqib ketmaydi).
 *
 * To'ldirish: mavjud `user_sessions` dan (yopilganlari ham) har
 * foydalanuvchi uchun MAX(`last_login_at`) va MAX(`last_seen_at`).
 * Faqat `admins` da bor user_id lar (FK). Qayta yurgizish xavfsiz
 * (`IF NOT EXISTS`, `ON CONFLICT` — mavjud qiymat kamaymaydi).
 *
 * down(): jadval o'chiriladi (ma'lumot faqat ko'rsatish uchun, pul/buyurtma
 * yo'q).
 */
export const CREATE_USER_ACTIVITY_SQL = `
      CREATE TABLE IF NOT EXISTS "identity_schema"."user_activity" (
        "user_id" bigint PRIMARY KEY
          REFERENCES "identity_schema"."admins"("id") ON DELETE CASCADE,
        "last_login_at" timestamptz NULL,
        "last_seen_at" timestamptz NULL
      );
    `;

export const BACKFILL_USER_ACTIVITY_SQL = `
      DO $$
      DECLARE
        filled integer;
      BEGIN
        IF to_regclass('"identity_schema"."user_sessions"') IS NULL THEN
          RETURN;
        END IF;

        WITH src AS (
          SELECT s."user_id",
                 MAX(s."last_login_at") AS "last_login_at",
                 MAX(s."last_seen_at") AS "last_seen_at"
            FROM "identity_schema"."user_sessions" s
           WHERE EXISTS (
             SELECT 1 FROM "identity_schema"."admins" a WHERE a."id" = s."user_id"
           )
           GROUP BY s."user_id"
        ), ins AS (
          INSERT INTO "identity_schema"."user_activity" ("user_id", "last_login_at", "last_seen_at")
          SELECT "user_id", "last_login_at", "last_seen_at" FROM src
          ON CONFLICT ("user_id") DO UPDATE
             SET "last_login_at" = GREATEST("user_activity"."last_login_at", EXCLUDED."last_login_at"),
                 "last_seen_at" = GREATEST("user_activity"."last_seen_at", EXCLUDED."last_seen_at")
          RETURNING 1
        )
        SELECT count(*)::integer INTO filled FROM ins;

        RAISE NOTICE 'UserActivity: % ta foydalanuvchi user_sessions dan to''ldirildi', filled;
      END
      $$;
    `;

export class UserActivity1716000000253 implements MigrationInterface {
  name = 'UserActivity1716000000253';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CREATE_USER_ACTIVITY_SQL);
    await queryRunner.query(BACKFILL_USER_ACTIVITY_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS "identity_schema"."user_activity"',
    );
  }
}
