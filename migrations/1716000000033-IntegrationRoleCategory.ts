import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integratsiyaga ROL, KATEGORIYA va REJIM qo'shish.
 *
 * MUAMMO. Modelda faqat `type` (`api`/`webhook`/`ftp`) bor edi — u TRANSPORT,
 * ya'ni "qanday gaplashamiz". "NIMA QILADI" degan savol hech qayerda
 * yozilmasdi: yetkazuvchi (bizdan posilka oladi) va manba (bizga buyurtma
 * beradi) bir xil ko'rinardi. Oqibati UI'da: barcha ulanish bitta uyumda,
 * to'lov tizimi yoki marketplace uchun esa umuman joy yo'q.
 *
 * ⚠️ MAVJUD QATORLAR uchun `role = 'carrier'`. Bu taxmin emas — kod
 * semantikasi shuni ko'rsatadi: `dispatch_config` bilan provayderda posilka
 * YARATILADI, `ProviderShipment`/`ProviderReceivable`/`ProviderRemittance`
 * bilan uning COD qarzi yuritiladi. Bu aynan yetkazuvchi naqshi.
 *
 * `category = 'cargo'` ham shu sababdan: mavjud ulanishlar cargo xizmatlari.
 * `integration_mode = 'adapter'`: ular bizning kontraktimizni bajarmaydi,
 * biz ularga config-profil bilan moslashamiz.
 *
 * Operator kerak bo'lsa har birini qo'lda to'g'rilaydi — bu bir martalik ish.
 *
 * Ustunlar `varchar` (enum EMAS): yangi rol/kategoriya qo'shish migratsiya
 * talab qilmasligi kerak, chunki taksonomiya hali o'sadi.
 */
export class IntegrationRoleCategory1716000000033
  implements MigrationInterface
{
  name = 'IntegrationRoleCategory1716000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        ADD COLUMN IF NOT EXISTS "role" varchar NOT NULL DEFAULT 'carrier',
        ADD COLUMN IF NOT EXISTS "category" varchar NOT NULL DEFAULT 'other',
        ADD COLUMN IF NOT EXISTS "integration_mode" varchar NOT NULL DEFAULT 'adapter'
    `);

    /**
     * Mavjud qatorlarni `cargo` deb belgilaymiz — standart `other` ularni
     * UI'da "boshqa" guruhiga tashlab, qayta tasniflashni talab qilardi.
     * Faqat hali tegilmagan (`other`) qatorlar.
     */
    await queryRunner.query(`
      UPDATE "integration_schema"."external_integrations"
      SET "category" = 'cargo'
      WHERE "category" = 'other' AND "role" = 'carrier'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_INTEGRATION_ROLE"
      ON "integration_schema"."external_integrations" ("role")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_INTEGRATION_ROLE"`,
    );
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        DROP COLUMN IF EXISTS "role",
        DROP COLUMN IF EXISTS "category",
        DROP COLUMN IF EXISTS "integration_mode"
    `);
  }
}
