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
 * To'ldirish: `user_sessions` + `activity_logs` (va arxivi) login
 * yozuvlaridan — `BACKFILL_USER_ACTIVITY_SQL`. Faqat `admins` da bor
 * user_id lar (FK). Qayta yurgizish xavfsiz (`IF NOT EXISTS`,
 * `ON CONFLICT` — mavjud qiymat kamaymaydi).
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

/**
 * Login yozuvi (`activity_logs`, `entity_type = 'Auth'`, `action = 'login'`)
 * dan vaqt: takroriy login birlashtirilgan bo'lsa (i6Nyedea) — oxirgisi
 * `metadata.last_at` da. Telegram Mini App kirishi (`metadata.method =
 * 'telegram'`) hisoblanmaydi — u sessiya ochmaydi, ilovadagi «Oxirgi kirish»
 * emas.
 */
const loginLogSourceSql = (table: string) => `
          SELECT l."uid" AS "user_id", MAX(l."at") AS "at"
            FROM (
              -- CASE: noto'g'ri user_id / last_at bo'lsa ham cast xato bermaydi
              -- (WHERE tartibi kafolatlanmagan).
              SELECT CASE WHEN x."user_id" ~ '^\\d{1,18}$' THEN x."user_id"::bigint END AS "uid",
                     GREATEST(
                       x."created_at",
                       CASE WHEN x."metadata"->>'last_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$'
                            THEN (x."metadata"->>'last_at')::timestamptz END
                     ) AS "at"
                FROM ${table} x
               WHERE x."entity_type" = 'Auth'
                 AND x."action" = 'login'
                 AND COALESCE(x."metadata"->>'method', '') <> 'telegram'
            ) l
           WHERE l."uid" IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM "identity_schema"."admins" a WHERE a."id" = l."uid"
             )
           GROUP BY l."uid"`;

const upsertFromLoginLogSql = (table: string) => `
        IF to_regclass('${table}') IS NOT NULL THEN
          WITH src AS (${loginLogSourceSql(table)}
          ), ins AS (
            INSERT INTO "identity_schema"."user_activity" ("user_id", "last_login_at", "last_seen_at")
            SELECT "user_id", "at", "at" FROM src
            ON CONFLICT ("user_id") DO UPDATE
               SET "last_login_at" = GREATEST("user_activity"."last_login_at", EXCLUDED."last_login_at"),
                   "last_seen_at" = GREATEST("user_activity"."last_seen_at", EXCLUDED."last_seen_at")
            RETURNING 1
          )
          SELECT count(*)::integer INTO step FROM ins;
          filled := filled + step;
        END IF;
`;

/**
 * To'ldirish uch manbadan (har biri bo'lmasa — o'tkazib yuboriladi), hammasi
 * `GREATEST` bilan birlashadi:
 *  1. `user_sessions` (2026-10-21 dan beri) — MAX(`last_login_at`) va
 *     MAX(`last_seen_at`), yopilgan sessiyalar ham;
 *  2. `activity_logs` login yozuvlari — sessiyalar jadvalidan OLDINgi
 *     kirishlar ham (auth yozuvlari ~90 kun saqlanadi);
 *  3. `activity_logs_archive` — arxivga ko'chganlari.
 */
export const BACKFILL_USER_ACTIVITY_SQL = `
      DO $$
      DECLARE
        filled integer := 0;
        step integer;
      BEGIN
        IF to_regclass('"identity_schema"."user_sessions"') IS NOT NULL THEN
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
          SELECT count(*)::integer INTO step FROM ins;
          filled := filled + step;
        END IF;
${upsertFromLoginLogSql('"identity_schema"."activity_logs"')}${upsertFromLoginLogSql('"identity_schema"."activity_logs_archive"')}
        RAISE NOTICE 'UserActivity: % ta yozuv to''ldirildi (user_sessions + activity_logs)', filled;
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
