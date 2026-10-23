import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (Elchi Pochta #3, 2026-10-23) "Telegram'dagidek": BITTA QURILMA — BITTA
 * SESSIYA, u aniq yopilmaguncha. Shu qurilma (`device_id`) qayta kirsa yangi
 * qator ochilmaydi — mavjud ochiq qator yangilanadi (`AuthSessionService.open`).
 *
 * - `user_sessions.last_login_at` timestamptz NOT NULL — oxirgi login vaqti
 *   (`created_at` endi — shu qurilmadan BIRINCHI login). Mavjud qatorlarda
 *   `created_at` dan to'ldiriladi.
 * - Dublikatlar: indeksdan OLDIN har (`user_id`, `device_id`) uchun bir
 *   nechta OCHIQ qator (`revoked_at IS NULL`) bo'lsa — eng oxirgi faoli
 *   (`last_seen_at`, keyin `created_at`) qoladi, qolganlari
 *   `revoked_at = now()`, `revoke_reason = 'merged'` bilan yopiladi (o'sha
 *   qurilmaning eski loginlari; brauzer cookie'si oxirgi loginniki).
 * - `UQ_USER_SESSIONS_USER_DEVICE_OPEN` — UNIQUE (`user_id`, `device_id`)
 *   WHERE `revoked_at` IS NULL AND `device_id` IS NOT NULL: qurilmada ko'pi
 *   bilan bitta ochiq qator (ikki tab bir vaqtda kirsa ham — ilova 23505 da
 *   mavjud qatorni yangilaydi).
 * - ESKI KOD MOSLIGI — `TRG_USER_SESSIONS_LEGACY_INSERT` (BEFORE INSERT):
 *   deploy migratsiyani servislar qayta yig'ilishidan OLDIN yurgizadi, xato
 *   bo'lsa eski kodga rollback qiladi. Eski identity har login'da yangi
 *   qator qo'shadi va `last_login_at` ni bilmaydi — indeks uni 23505 bilan
 *   yiqitib, qaytgan qurilmalar login qila olmay qolardi. Trigger FAQAT
 *   `last_login_at` siz INSERT'da ishlaydi (yangi kod uni doim yozadi —
 *   unga ta'sir yo'q): `last_login_at := created_at` va shu qurilmaning
 *   avvalgi ochiq qatori `merged` bilan yopiladi (dedup bilan bir xil
 *   qoida). Shu sabab ustunda DEFAULT YO'Q. Hamma servislar yangi kodda
 *   bo'lgach trigger keraksiz — keyingi migratsiya o'chirishi mumkin.
 *
 * XAVFSIZLIK: dedup va indeks BITTA `DO` blokida, jadval
 * `SHARE ROW EXCLUSIVE` qulfi ostida — o'qish davom etadi, yozish (login /
 * refresh) qisqa vaqt kutadi, dedup bilan indeks orasida yangi dublikat
 * paydo bo'lolmaydi. Indeks bor bo'lsa dedup qayta yurmaydi — qayta
 * yurgizish xavfsiz. Jadval kichik (har foydalanuvchiga bir necha qator).
 *
 * down(): trigger, indeks va ustun o'chiriladi. `merged` bilan yopilgan
 * qatorlar YOPIQLIGICHA qoladi (qayta ochish xavfsiz emas: ularning tokeni
 * brauzerda yo'q) — eski kod uchun ular oddiy yopilgan sessiya.
 */
export class UserSessionsDeviceReuse1716000000140 implements MigrationInterface {
  name = 'UserSessionsDeviceReuse1716000000140';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."user_sessions" ADD COLUMN IF NOT EXISTS "last_login_at" timestamptz NULL`,
    );
    await queryRunner.query(
      `UPDATE "identity_schema"."user_sessions" SET "last_login_at" = "created_at" WHERE "last_login_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."user_sessions" ALTER COLUMN "last_login_at" SET NOT NULL`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "identity_schema"."user_sessions_legacy_insert"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."last_login_at" IS NULL THEN
          NEW."last_login_at" := COALESCE(NEW."created_at", now());
          IF NEW."device_id" IS NOT NULL AND NEW."revoked_at" IS NULL THEN
            UPDATE "identity_schema"."user_sessions"
               SET "revoked_at" = now(), "revoke_reason" = 'merged'
             WHERE "user_id" = NEW."user_id"
               AND "device_id" = NEW."device_id"
               AND "revoked_at" IS NULL;
          END IF;
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_USER_SESSIONS_LEGACY_INSERT"
        ON "identity_schema"."user_sessions"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_USER_SESSIONS_LEGACY_INSERT"
      BEFORE INSERT ON "identity_schema"."user_sessions"
      FOR EACH ROW EXECUTE FUNCTION "identity_schema"."user_sessions_legacy_insert"()
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        merged integer;
      BEGIN
        IF to_regclass('identity_schema."UQ_USER_SESSIONS_USER_DEVICE_OPEN"') IS NOT NULL THEN
          RETURN;
        END IF;

        LOCK TABLE "identity_schema"."user_sessions" IN SHARE ROW EXCLUSIVE MODE;

        UPDATE "identity_schema"."user_sessions" s
           SET "revoked_at" = now(), "revoke_reason" = 'merged'
          FROM (
            SELECT "id",
                   row_number() OVER (
                     PARTITION BY "user_id", "device_id"
                     ORDER BY "last_seen_at" DESC, "created_at" DESC, "id" DESC
                   ) AS rn
              FROM "identity_schema"."user_sessions"
             WHERE "revoked_at" IS NULL AND "device_id" IS NOT NULL
          ) d
         WHERE d."id" = s."id" AND d.rn > 1;
        GET DIAGNOSTICS merged = ROW_COUNT;
        IF merged > 0 THEN
          RAISE NOTICE 'Elchi Pochta #3: user_sessions — % ta takroriy qurilma sessiyasi yopildi (merged)', merged;
        END IF;

        CREATE UNIQUE INDEX "UQ_USER_SESSIONS_USER_DEVICE_OPEN"
          ON "identity_schema"."user_sessions" ("user_id", "device_id")
          WHERE "revoked_at" IS NULL AND "device_id" IS NOT NULL;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_USER_SESSIONS_LEGACY_INSERT"
        ON "identity_schema"."user_sessions"
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "identity_schema"."user_sessions_legacy_insert"()`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "identity_schema"."UQ_USER_SESSIONS_USER_DEVICE_OPEN"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."user_sessions" DROP COLUMN IF EXISTS "last_login_at"`,
    );
  }
}
