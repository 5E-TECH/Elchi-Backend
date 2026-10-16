import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (ysBqD9Nx #5) Umumlashtirilgan Telegram chat sxemasi — `telegram_chats`
 * (chat_id, chat_type: private|group|channel, owner_type:
 * market|market_operator|courier|branch|user, owner_id, scope, is_active,
 * linked_at, linked_by).
 *
 *  - Mavjud `telegram_markets` yozuvlari KO'CHIRILADI (owner_type='market',
 *    scope = group_type: create|cancel). Hech bir yozuv yo'qolmaydi:
 *    o'chirilgan (is_deleted) qatorlar ham `is_active=false` bo'lib o'tadi.
 *  - `telegram_markets` hozircha relay manbai sifatida QOLADI; har qanday
 *    INSERT/UPDATE/DELETE trigger orqali `telegram_chats` ga aks etadi
 *    (`source_market_row_id`) — bot guruhdan chiqarilsa (my_chat_member →
 *    telegram_markets.is_active=false) telegram_chats ham nofaol bo'ladi.
 *  - Ko'p operator: guruhda alohida rol modeli YO'Q (market_operator —
 *    akkaunt darajasida); bu jadval faqat chat ↔ egasi bog'lanishi.
 * Qayta ishga tushirish xavfsiz.
 */
export class TelegramChats1716000000126 implements MigrationInterface {
  name = 'TelegramChats1716000000126';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_chats" (
        "id" BIGSERIAL PRIMARY KEY,
        "chat_id" varchar(64) NOT NULL,
        "chat_type" varchar(16) NOT NULL,
        "owner_type" varchar(24) NOT NULL,
        "owner_id" bigint NOT NULL,
        "scope" varchar(32) NOT NULL DEFAULT 'default',
        "is_active" boolean NOT NULL DEFAULT true,
        "linked_at" timestamptz NOT NULL DEFAULT now(),
        "linked_by" bigint NULL,
        "source_market_row_id" bigint NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_TELEGRAM_CHATS_TYPE"
          CHECK ("chat_type" IN ('private', 'group', 'channel')),
        CONSTRAINT "CHK_TELEGRAM_CHATS_OWNER"
          CHECK ("owner_type" IN ('market', 'market_operator', 'courier', 'branch', 'user'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_TELEGRAM_CHATS_SOURCE_MARKET"
      ON "notification_schema"."telegram_chats" ("source_market_row_id")
      WHERE "source_market_row_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TELEGRAM_CHATS_OWNER"
      ON "notification_schema"."telegram_chats" ("owner_type", "owner_id", "scope")
      WHERE "is_active" = true
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TELEGRAM_CHATS_CHAT"
      ON "notification_schema"."telegram_chats" ("chat_id")
    `);

    // telegram_markets → telegram_chats (bir martalik ko'chirish).
    await queryRunner.query(`
      INSERT INTO "notification_schema"."telegram_chats"
        ("chat_id", "chat_type", "owner_type", "owner_id", "scope", "is_active",
         "linked_at", "source_market_row_id")
      SELECT tm."group_id",
             CASE WHEN tm."group_id" LIKE '-%' THEN 'group' ELSE 'private' END,
             'market', tm."market_id", tm."group_type"::text,
             (tm."is_active" AND NOT tm."is_deleted"),
             tm."createdAt", tm."id"
        FROM "notification_schema"."telegram_markets" tm
      ON CONFLICT ("source_market_row_id") WHERE "source_market_row_id" IS NOT NULL
      DO NOTHING
    `);

    // Doimiy sinxron: telegram_markets o'zgarishi telegram_chats ga.
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
      DROP TRIGGER IF EXISTS "TRG_TELEGRAM_MARKETS_SYNC_CHATS"
        ON "notification_schema"."telegram_markets"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_TELEGRAM_MARKETS_SYNC_CHATS"
      AFTER INSERT OR UPDATE OR DELETE ON "notification_schema"."telegram_markets"
      FOR EACH ROW EXECUTE FUNCTION "notification_schema"."telegram_markets_sync_chats"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_TELEGRAM_MARKETS_SYNC_CHATS"
        ON "notification_schema"."telegram_markets"
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "notification_schema"."telegram_markets_sync_chats"()`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_chats"`,
    );
  }
}
