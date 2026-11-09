import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carrier API — tashqi yetkazuvchi kompaniya akkauntlari.
 *
 * `carrier_accounts` — har bir qator: kompaniya nomi, API kalit HASH'i,
 * bog'langan kurier user (`identity_schema.admins.id`), IP allowlist,
 * aktivlik. Kalit gateway'dagi `CarrierApiKeyGuard` orqali tekshiriladi.
 *
 * Partner jadvaliga (`partners`) TEGMAYDI — ataylab alohida: carrier kaliti
 * buyurtma yarata olmasin, partner kaliti esa kurier nomidan ishlay olmasin.
 *
 * `courier_user_id` o'chirilmagan qatorlar orasida unique — bitta kurier
 * akkaunti ikki kompaniyaga berilmasin.
 */
export class CreateCarrierAccounts1716000000215 implements MigrationInterface {
  name = 'CreateCarrierAccounts1716000000215';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."carrier_accounts" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "name" VARCHAR NOT NULL,
        "courier_user_id" BIGINT NOT NULL,
        "api_key_hash" VARCHAR NOT NULL,
        "ip_allowlist" JSONB,
        "is_active" BOOLEAN NOT NULL DEFAULT true
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_CARRIER_API_KEY_HASH"
      ON "integration_schema"."carrier_accounts" ("api_key_hash");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CARRIER_ACTIVE"
      ON "integration_schema"."carrier_accounts" ("is_active");
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_CARRIER_COURIER_USER"
      ON "integration_schema"."carrier_accounts" ("courier_user_id")
      WHERE "is_deleted" = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."carrier_accounts" CASCADE;`,
    );
  }
}
