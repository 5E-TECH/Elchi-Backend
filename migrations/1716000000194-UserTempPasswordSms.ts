import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * aidsxJ2H — foydalanuvchi yaratishda tasodifiy parol + SMS (identity_schema).
 *
 * 1) `admins.password_change_forced` (sukut `false`): parolni ADMIN / TIZIM
 *    bergan (`password_mode: 'generate_sms'` yoki `manual` +
 *    `must_change_password: true`, yoki «SMS'ni qayta yuborish») — bunday
 *    foydalanuvchi parolni almashtirmaguncha gateway darvozasi
 *    (`PasswordChangeGuard`) `PASSWORD_CHANGE_GATE` ga QARAMAY ishlaydi.
 *    NDmZMzCP ning «zaif eski parol» bayrog'i (`must_change_password`,
 *    darvoza env bilan) o'zgarmaydi. Mavjud foydalanuvchilar `false` —
 *    hech kim qulflanmaydi. O'zi parolni almashtirsa `false`.
 *
 * 2) `user_password_sms` — vaqtinchalik parol SMS'lari jurnali: qayta
 *    yuborish chegarasi (60 s / kuniga 5) va yetkazish holati shu yerdan
 *    (`client_message_id` → notification `sms_outbox`). PAROL YOZILMAYDI.
 *
 * XAVFSIZLIK: pulga tegmaydi. `IF NOT EXISTS` — qayta yurgizish xatosiz.
 *
 * QULF: `ADD COLUMN … NOT NULL DEFAULT false` (doimiy sukut) — PG 11+ da faqat
 * metama'lumot, jadval qayta yozilmaydi. `lock_timeout` 5 s: band `admins`
 * jadvalida ACCESS EXCLUSIVE navbatida cheksiz kutib, butun trafikni
 * to'xtatib qo'ymasin — deploy xato bilan to'xtaydi va qayta yurgiziladi.
 * Sozlama faqat shu blokda (oxirida avvalgisi tiklanadi): TypeORM barcha
 * migratsiyalarni bitta tranzaksiyada yurgizadi.
 *
 * down(): jadval va ustun o'chiriladi (SMS jurnali yo'qoladi, parollarga
 * tegmaydi).
 */
export class UserTempPasswordSms1716000000194 implements MigrationInterface {
  name = 'UserTempPasswordSms1716000000194';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
      BEGIN
        IF to_regclass('identity_schema.admins') IS NULL THEN
          RETURN;
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);
        ALTER TABLE "identity_schema"."admins"
          ADD COLUMN IF NOT EXISTS "password_change_forced" boolean NOT NULL DEFAULT false;
        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "identity_schema"."user_password_sms" (
        "id" BIGSERIAL NOT NULL,
        "user_id" bigint NOT NULL,
        "client_message_id" varchar(64) NOT NULL,
        "reason" varchar(16) NOT NULL,
        "requested_by" bigint NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "failure_reason" varchar(64) NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_USER_PASSWORD_SMS" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_USER_PASSWORD_SMS_CLIENT_MESSAGE_ID" UNIQUE ("client_message_id"),
        CONSTRAINT "CHK_USER_PASSWORD_SMS_REASON" CHECK ("reason" IN ('create', 'resend')),
        CONSTRAINT "CHK_USER_PASSWORD_SMS_STATUS" CHECK ("status" IN ('pending', 'sent', 'delivered', 'failed'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_USER_PASSWORD_SMS_USER_CREATED"
      ON "identity_schema"."user_password_sms" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "identity_schema"."user_password_sms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "password_change_forced"`,
    );
  }
}
