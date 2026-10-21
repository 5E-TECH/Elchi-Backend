import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (Elchi Pochta #3 — "Sessionlar bo'limi") Har login uchun alohida sessiya.
 *
 * - `identity_schema.admins.session_epoch` integer NOT NULL DEFAULT 0 —
 *   xavfsizlik hodisasi (parol/telefon/rol almashishi, bloklash, o'chirish)
 *   uni oshiradi va eski sessiyalarning HAMMASI yaroqsiz bo'ladi. Doimiy
 *   sukut — jadval qayta yozilmaydi (PG 11+ "fast default").
 * - `identity_schema.user_sessions` — OCHIQ TOKEN SAQLANMAYDI, faqat refresh
 *   JWT'ning sha256 hashi (UNIQUE). `id` — UUID, ilova yaratadi (DB sukuti
 *   yo'q: kengaytmaga bog'liqlik yo'q). `user_id` → admins(id) FK (bir sxema
 *   ichida, 1716000000089 bilan bir xil).
 * - Indekslar: egasining faol sessiyalari (`user_id`, `last_seen_at`) WHERE
 *   `revoked_at` IS NULL — ro'yxat va soni; `expires_at` — tozalash.
 *
 * Ortga-moslik: mavjud `admins.refresh_token` hashlari KO'CHIRILMAYDI —
 * deploy paytida kirgan foydalanuvchining sessiya qatori birinchi refresh'da
 * yaratiladi (aniq login vaqti `iat` va muddati `exp` bilan). Hech kim
 * chiqarib yuborilmaydi. Qayta ishga tushirish xavfsiz.
 */
export class CreateUserSessions1716000000130 implements MigrationInterface {
  name = 'CreateUserSessions1716000000130';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" ADD COLUMN IF NOT EXISTS "session_epoch" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "identity_schema"."user_sessions" (
        "id" uuid PRIMARY KEY,
        "user_id" bigint NOT NULL
          REFERENCES "identity_schema"."admins" ("id") ON DELETE CASCADE,
        "refresh_token_hash" varchar(64) NOT NULL,
        "epoch" integer NOT NULL DEFAULT 0,
        "password_fp" varchar(32) NOT NULL,
        "method" varchar(16) NOT NULL DEFAULT 'password',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz NULL,
        "revoke_reason" varchar(32) NULL,
        "device_id" varchar(128) NULL,
        "device_name" varchar(128) NULL,
        "user_agent" varchar(256) NULL,
        "ip" varchar(64) NULL,
        CONSTRAINT "CHK_USER_SESSIONS_METHOD"
          CHECK ("method" IN ('password', 'otp', 'legacy'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_USER_SESSIONS_REFRESH_HASH" ON "identity_schema"."user_sessions" ("refresh_token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_USER_SESSIONS_USER_ACTIVE" ON "identity_schema"."user_sessions" ("user_id", "last_seen_at" DESC) WHERE "revoked_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_USER_SESSIONS_EXPIRES" ON "identity_schema"."user_sessions" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "identity_schema"."user_sessions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "session_epoch"`,
    );
  }
}
