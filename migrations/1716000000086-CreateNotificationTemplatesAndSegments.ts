import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (C4R3YyvH) `notification_schema.notification_templates` — bildirishnoma
 * shablonlari reyestri, uch til.
 * (ebSV5oyP) `notification_schema.notification_audience_segments` — nom
 * bilan saqlangan auditoriya (keyingi kampaniyada qayta ishlatiladi).
 *
 * • `code` = katalogdagi `type` (libs/common notification-types.ts);
 * • `lang` — 'uz' | 'ru' | 'en'; `channel` — NULL = umumiy (inbox qatori
 *   matni, u SMS/Telegram/push'ga ham ketadi) yoki aniq kanal;
 * • `required_vars` — fail-closed render: `data` da yo'q bo'lsa XATO;
 * • UNIQUE (code, lang, channel) — NULL kanal ham takrorlanmaydi
 *   (`COALESCE(channel, '')` ifoda indeksi; PG15 `NULLS NOT DISTINCT` siz);
 * • soft-delete ustuni `is_deleted`; vaqt ustunlari BaseEntity bilan bir xil.
 */
export class CreateNotificationTemplatesAndSegments1716000000086 implements MigrationInterface {
  name = 'CreateNotificationTemplatesAndSegments1716000000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."notification_templates" (
        "id" BIGSERIAL PRIMARY KEY,
        "code" VARCHAR(120) NOT NULL,
        "lang" VARCHAR(2) NOT NULL DEFAULT 'uz'
          CHECK ("lang" IN ('uz', 'ru', 'en')),
        "channel" VARCHAR(16)
          CHECK ("channel" IS NULL OR "channel" IN ('realtime', 'telegram', 'sms', 'email', 'push')),
        "title" VARCHAR(255) NOT NULL,
        "body" TEXT,
        "required_vars" TEXT[] NOT NULL DEFAULT '{}',
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "updated_by" BIGINT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_NOTIF_TEMPLATE_CODE_LANG_CHANNEL"
      ON "notification_schema"."notification_templates" ("code", "lang", (COALESCE("channel", '')))
    `);

    // (ebSV5oyP) Saqlangan segment: FAQAT shart (rollar/segment filtri) —
    // telefon/ism ro'yxati SAQLANMAYDI; son har safar jonli qayta sanaladi.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."notification_audience_segments" (
        "id" BIGSERIAL PRIMARY KEY,
        "name" VARCHAR(120) NOT NULL,
        "description" VARCHAR(500),
        "audience" JSONB NOT NULL,
        "last_total" INTEGER,
        "last_counted_at" TIMESTAMPTZ,
        "created_by" BIGINT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_NOTIF_AUDIENCE_SEGMENT_NAME"
      ON "notification_schema"."notification_audience_segments" (LOWER("name"))
      WHERE "is_deleted" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."notification_audience_segments" CASCADE`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."notification_templates" CASCADE`,
    );
  }
}
