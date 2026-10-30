import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (dgvwZasd B) Shaxsiy fayl egaligi reestri: `file_schema.file_objects`.
 *
 * file-service shu paytgacha bazasiz edi; endi faqat shu bitta jadval uchun
 * o'z sxemasi bor (`POSTGRES_URI` umumiy `.env`da, `DB_SCHEMA` sukuti
 * `file_schema`). Har yuklangan shaxsiy fayl uchun qator: kim yuklagan, roli,
 * filiali. O'qish qoidasi gateway'da (`assertCanAccessPrivateKey`).
 *
 * XAVFSIZLIK: yangi jadval — pul va mavjud jadvallarga tegmaydi, band jadval
 * qulfi yo'q (shu sababli `lock_timeout` bloki kerak emas). Eski fayllar
 * orqaga yozilmaydi: reestrda yo'q kalit eski (kalit prefiksi + buyurtma
 * egasi) qoidasi bilan ishlaydi. `IF NOT EXISTS` — qayta yurgizish xatosiz.
 *
 * down(): jadval o'chiriladi (MinIO fayllariga tegilmaydi, hammasi yana eski
 * qoidaga o'tadi). Sxema qoladi: `init-schemas.sql` / `db-prepare` ham yaratadi.
 */
export class FileOwnershipRegistry1716000000193 implements MigrationInterface {
  name = 'FileOwnershipRegistry1716000000193';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "file_schema"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "file_schema"."file_objects" (
        "key" varchar(1024) PRIMARY KEY,
        "folder" varchar(64) NOT NULL,
        "owner_id" varchar(64) NULL,
        "owner_role" varchar(32) NULL,
        "owner_branch_id" varchar(32) NULL,
        "mime_type" varchar(128) NOT NULL,
        "size_bytes" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FILE_OBJECTS_OWNER"
      ON "file_schema"."file_objects" ("owner_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "file_schema"."file_objects"`,
    );
  }
}
