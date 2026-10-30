import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOT-2 #5 — market Telegram guruhini KIM ulagani:
 * `notification_schema.telegram_markets.linked_by bigint NULL`.
 *
 *  - Eski qatorlar audit jurnalidan to'ldiriladi
 *    (`activity_logs`: `TelegramMarket` / `notification.tg_group_connected`,
 *    `metadata.linked_by`; admin qo'lda yaratgan — `created`, `user_id`);
 *    topilmasa NULL (noma'lum) qoladi.
 *  - `telegram_markets_sync_chats` trigger funksiyasi (1716000000126) endi
 *    `linked_by` ni ham `telegram_chats` ga aks ettiradi; mavjud
 *    `telegram_chats` qatorlari ham to'ldiriladi.
 *
 * XAVFSIZLIK: pulga va yuborishga tegmaydi. `ADD COLUMN … NULL` — faqat
 * metama'lumot. `IF NOT EXISTS` / `CREATE OR REPLACE` — qayta yurgizish
 * xatosiz. down(): trigger funksiyasi 126-dagi holatiga qaytadi, ustun
 * o'chiriladi (`telegram_chats.linked_by` qoladi — u 126 dan bor).
 */
export class TelegramMarketsLinkedBy1716000000189 implements MigrationInterface {
  name = 'TelegramMarketsLinkedBy1716000000189';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
        ADD COLUMN IF NOT EXISTS "linked_by" bigint NULL
    `);

    // Eski ulanishlar — audit jurnalidan (eng so'nggi ulash yozuvi).
    await queryRunner.query(`
      UPDATE "notification_schema"."telegram_markets" tm
         SET "linked_by" = src."linked_by"
        FROM (
          SELECT DISTINCT ON (al."entity_id")
                 al."entity_id",
                 (al."metadata"->>'linked_by')::bigint AS "linked_by"
            FROM "notification_schema"."activity_logs" al
           WHERE al."entity_type" = 'TelegramMarket'
             AND al."action" = 'notification.tg_group_connected'
             AND (al."metadata"->>'linked_by') ~ '^[0-9]{1,18}$'
           ORDER BY al."entity_id", al."created_at" DESC
        ) src
       WHERE src."entity_id" = tm."id"::text
         AND tm."linked_by" IS NULL
    `);
    // Admin qo'lda yaratgan ulanishlar (POST /notifications) — `created`.
    await queryRunner.query(`
      UPDATE "notification_schema"."telegram_markets" tm
         SET "linked_by" = src."linked_by"
        FROM (
          SELECT DISTINCT ON (al."entity_id")
                 al."entity_id",
                 al."user_id"::bigint AS "linked_by"
            FROM "notification_schema"."activity_logs" al
           WHERE al."entity_type" = 'TelegramMarket'
             AND al."action" = 'created'
             AND al."user_id" ~ '^[0-9]{1,18}$'
           ORDER BY al."entity_id", al."created_at" DESC
        ) src
       WHERE src."entity_id" = tm."id"::text
         AND tm."linked_by" IS NULL
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "notification_schema"."telegram_markets_sync_chats"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          UPDATE "notification_schema"."telegram_chats"
             SET "is_active" = false, "updated_at" = now()
           WHERE "source_market_row_id" = OLD."id";
          RETURN OLD;
        END IF;
        INSERT INTO "notification_schema"."telegram_chats"
          ("chat_id", "chat_type", "owner_type", "owner_id", "scope", "is_active",
           "linked_at", "linked_by", "source_market_row_id")
        VALUES (
          NEW."group_id",
          CASE WHEN NEW."group_id" LIKE '-%' THEN 'group' ELSE 'private' END,
          'market', NEW."market_id", NEW."group_type"::text,
          (NEW."is_active" AND NOT NEW."is_deleted"),
          COALESCE(NEW."createdAt", now()), NEW."linked_by", NEW."id")
        ON CONFLICT ("source_market_row_id") WHERE "source_market_row_id" IS NOT NULL
        DO UPDATE SET
          "chat_id" = EXCLUDED."chat_id",
          "chat_type" = EXCLUDED."chat_type",
          "owner_id" = EXCLUDED."owner_id",
          "scope" = EXCLUDED."scope",
          "is_active" = EXCLUDED."is_active",
          "linked_by" = EXCLUDED."linked_by",
          "updated_at" = now();
        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      UPDATE "notification_schema"."telegram_chats" tc
         SET "linked_by" = tm."linked_by"
        FROM "notification_schema"."telegram_markets" tm
       WHERE tc."source_market_row_id" = tm."id"
         AND tm."linked_by" IS NOT NULL
         AND tc."linked_by" IS DISTINCT FROM tm."linked_by"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "notification_schema"."telegram_markets_sync_chats"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          UPDATE "notification_schema"."telegram_chats"
             SET "is_active" = false, "updated_at" = now()
           WHERE "source_market_row_id" = OLD."id";
          RETURN OLD;
        END IF;
        INSERT INTO "notification_schema"."telegram_chats"
          ("chat_id", "chat_type", "owner_type", "owner_id", "scope", "is_active",
           "linked_at", "source_market_row_id")
        VALUES (
          NEW."group_id",
          CASE WHEN NEW."group_id" LIKE '-%' THEN 'group' ELSE 'private' END,
          'market', NEW."market_id", NEW."group_type"::text,
          (NEW."is_active" AND NOT NEW."is_deleted"),
          COALESCE(NEW."createdAt", now()), NEW."id")
        ON CONFLICT ("source_market_row_id") WHERE "source_market_row_id" IS NOT NULL
        DO UPDATE SET
          "chat_id" = EXCLUDED."chat_id",
          "chat_type" = EXCLUDED."chat_type",
          "owner_id" = EXCLUDED."owner_id",
          "scope" = EXCLUDED."scope",
          "is_active" = EXCLUDED."is_active",
          "updated_at" = now();
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
        DROP COLUMN IF EXISTS "linked_by"
    `);
  }
}
