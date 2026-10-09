import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (dzyVftBx) Viloyatga logist biriktirish domeni.
 *
 * 1. `identity_schema.admins.role` Postgres ENUM — unga `'logist'` qiymati
 *    qo'shiladi (`Roles.LOGIST`). Enum turi nomi `pg_attribute` orqali
 *    aniqlanadi (1713207000000 naqshi) — nom o'zgargan muhitda ham ishlaydi.
 *    `ADD VALUE IF NOT EXISTS` — qayta ishga tushirish xavfsiz. Yangi qiymat
 *    shu migratsiyada ISHLATILMAYDI (Postgres buni bitta tranzaksiyada
 *    taqiqlaydi).
 *
 * 2. `logistics_schema.regions.logist_id bigint NULL` + indeks.
 *
 *    FK YO'Q — ataylab. Har servis o'z sxemasida (schema-per-service) va
 *    loyihada sxemalararo FK umuman yo'q; bundan tashqari foydalanuvchi
 *    o'chirilganda qator SOFT-delete bo'ladi (`is_deleted = true`), ya'ni
 *    `ON DELETE SET NULL` hech qachon ishga tushmasdi — FK yolg'on kafolat
 *    bo'lardi. SET NULL semantikasini ilova qatlami ta'minlaydi: identity
 *    `deleteUser` logistni o'chirishdan OLDIN `logistics.region.clear_logist`
 *    ni chaqiradi (fail-closed).
 */
export class RegionLogistAssignment1716000000060 implements MigrationInterface {
  name = 'RegionLogistAssignment1716000000060';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE role_enum regtype;
      BEGIN
        SELECT a.atttypid::regtype
        INTO role_enum
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'identity_schema'
          AND c.relname = 'admins'
          AND a.attname = 'role'
          AND a.attnum > 0
          AND NOT a.attisdropped
        LIMIT 1;

        IF role_enum IS NOT NULL THEN
          EXECUTE format(
            'ALTER TYPE %s ADD VALUE IF NOT EXISTS %L',
            role_enum,
            'logist'
          );
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `ALTER TABLE "logistics_schema"."regions" ADD COLUMN IF NOT EXISTS "logist_id" bigint NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_REGION_LOGIST" ON "logistics_schema"."regions" ("logist_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "logistics_schema"."IDX_REGION_LOGIST"`,
    );
    await queryRunner.query(
      `ALTER TABLE "logistics_schema"."regions" DROP COLUMN IF EXISTS "logist_id"`,
    );
    // Enum qiymati ('logist') olib tashlanmaydi: Postgres'da enum qiymatini
    // o'chirish turni qayta qurishni talab qiladi va logist qatorlari unga
    // tayanadi (1716000000010 / 1716000000017 bilan bir xil yondashuv).
  }
}
