import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NDmZMzCP — telefon bo'yicha xato login hisoblagichi + backoff
 * (`identity_schema.auth_login_throttle`). Redis yo'q — holat Postgres'da,
 * shuning uchun bir nechta identity instansi bir xil hisobni ko'radi.
 *
 * Kalit (`key`) — telefonning HMAC hash'i (raqam o'zi YOZILMAYDI):
 *   `p:<hash>`         — shu telefon, barcha IP'lar;
 *   `pi:<hash>:<ip>`   — shu telefon + shu IP.
 * `fail_count` — ketma-ket xatolar (muvaffaqiyatli kirish — qator o'chadi),
 * `locked_until` — shu vaqtgacha login (parol tekshirilmay) 429. Qulf
 * VAQTINCHALIK (ko'pi bilan 15 daqiqa) — qoida `auth/login-throttle.ts`.
 *
 * Yangi jadval: mavjud ma'lumotga tegmaydi, qayta yurgizish xavfsiz.
 */
export class AuthLoginThrottle1716000000164 implements MigrationInterface {
  name = 'AuthLoginThrottle1716000000164';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "identity_schema"."auth_login_throttle" (
        "key" varchar(160) NOT NULL,
        "fail_count" integer NOT NULL DEFAULT 0,
        "first_failed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_failed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "locked_until" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "PK_AUTH_LOGIN_THROTTLE" PRIMARY KEY ("key")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AUTH_LOGIN_THROTTLE_LAST_FAILED" ON "identity_schema"."auth_login_throttle" ("last_failed_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "identity_schema"."auth_login_throttle"`,
    );
  }
}
