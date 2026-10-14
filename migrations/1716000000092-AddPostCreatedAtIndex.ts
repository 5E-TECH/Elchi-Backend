import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * YfrqN70i / kA70Rban — "Eski pochtalar" endi server tomonda sahifalanadi va
 * sana bo'yicha filtrlanadi: `ORDER BY "createdAt" DESC LIMIT/OFFSET` va
 * `"createdAt" BETWEEN ...`. Status/kuryer/viloyat/filial indekslari bor edi,
 * `createdAt` niki yo'q edi — arxiv o'sgani sari har sahifa butun jadvalni
 * saralardi.
 *
 * ⚠️ CONCURRENTLY EMAS (TypeORM migratsiyasi tranzaksiya ichida ishlaydi).
 * Xavfsiz: `logistics_schema.posts` kichik jadval (prod'da ~60 qator; yiliga
 * bir necha ming) — CREATE INDEX bir necha millisekund SHARE qulfi oladi
 * (o'qish to'xtamaydi, yozish shu ms davomida kutadi). `IF NOT EXISTS` —
 * qayta ishga tushirish xavfsiz.
 */
export class AddPostCreatedAtIndex1716000000092 implements MigrationInterface {
  name = 'AddPostCreatedAtIndex1716000000092';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POST_CREATED_AT" ON "logistics_schema"."posts" ("createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "logistics_schema"."IDX_POST_CREATED_AT"`,
    );
  }
}
