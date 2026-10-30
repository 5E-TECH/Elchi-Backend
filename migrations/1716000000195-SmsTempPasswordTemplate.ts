import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * aidsxJ2H — vaqtinchalik parol SMS'i (notification_schema).
 *
 * 1) `sms_outbox.redacted_text`: maxfiy SMS (parol) uchun ALLAQACHON
 *    maskalangan matn. Provayder qabul qilgach / terminal xatoda `text`
 *    shu bilan almashtiriladi — parol DB'da faqat yuborilguncha turadi
 *    (OTP'dagi `******` qoidasi bilan bir xil; OTP qatorlarida NULL —
 *    avvalgi regex maskasi ishlaydi).
 *
 * 2) `sms_templates` ga `user.temp_password` (uz, «security» sinfi).
 *    `provider_template_id` NULL — operator provayderda (Eskiz)
 *    tasdiqlatishi kerak (`needs_provider_approval: true`). Mavjud bo'lsa
 *    tegilmaydi (ON CONFLICT DO NOTHING).
 *
 * XAVFSIZLIK: pulga tegmaydi. `IF NOT EXISTS` — qayta yurgizish xatosiz.
 *
 * QULF: nullable ustun — faqat metama'lumot; `lock_timeout` 5 s (SMS
 * navbati band bo'lsa deploy xato bilan to'xtaydi, trafik to'xtab qolmaydi).
 *
 * down(): tasdiqlanmagan shablon va ustun o'chiriladi. Ustun yo'qolgach
 * parolni maskalab bo'lmaydi — yuborilmagan parol SMS'lari OLDIN yopiladi
 * (`text` maskalanadi, holat `failed`).
 */
export class SmsTempPasswordTemplate1716000000195 implements MigrationInterface {
  name = 'SmsTempPasswordTemplate1716000000195';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
      BEGIN
        IF to_regclass('notification_schema.sms_outbox') IS NULL THEN
          RETURN;
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);
        ALTER TABLE "notification_schema"."sms_outbox"
          ADD COLUMN IF NOT EXISTS "redacted_text" text NULL;
        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
      END $$;
    `);
    await queryRunner.query(
      `INSERT INTO "notification_schema"."sms_templates"
         ("code", "message_class", "lang", "text", "required_vars", "provider_template_id", "is_active")
       VALUES ($1, 'security', 'uz', $2, ARRAY['login', 'password']::text[], NULL, TRUE)
       ON CONFLICT ("code", "lang") DO NOTHING`,
      [
        'user.temp_password',
        'Elchi Pochta: hisobingiz yaratildi. Login: {{login}}, parol: {{password}} . Kirish: admin.elchipochta.uz. Parolni hech kimga bermang.',
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notification_schema"."sms_templates" WHERE "code" = 'user.temp_password' AND "provider_template_id" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "notification_schema"."sms_outbox"
          SET "text" = "redacted_text",
              "status" = 'failed',
              "next_retry_at" = NULL,
              "last_error" = 'cancelled: migration reverted'
        WHERE "redacted_text" IS NOT NULL AND "text" <> "redacted_text"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."sms_outbox" DROP COLUMN IF EXISTS "redacted_text"`,
    );
  }
}
