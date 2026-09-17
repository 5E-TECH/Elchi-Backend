import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `partner_webhook_outbox.duration_ms` — webhook javob vaqti.
 *
 * Integratsiya panelida "o'rtacha javob vaqti" ko'rsatiladi. U sekinlashuvni
 * ERTA aniqlashning yagona belgisi: hamkor hali 200 qaytarib turadi-yu,
 * javob vaqti 200 ms dan 8 s ga o'sgan bo'lsa — keyingi qadam timeout va
 * yo'qolgan hodisa.
 *
 * Ilgari hech qayerda o'lchanmasdi. Panelda uydirma raqam ko'rsatishdan ko'ra
 * o'lchashni boshlash to'g'ri, shuning uchun ustun qo'shiladi.
 *
 * `NULL` — hali urinish bo'lmagan yoki javob umuman kelmagan (tarmoq xatosi).
 * Mavjud qatorlar `NULL` bo'lib qoladi: ular uchun vaqt o'lchanmagan va
 * 0 deb yozish o'rtachani buzardi.
 */
export class WebhookDurationMs1716000000034 implements MigrationInterface {
  name = 'WebhookDurationMs1716000000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partner_webhook_outbox"
        ADD COLUMN IF NOT EXISTS "duration_ms" integer
    `);
    /**
     * Metrika so'rovi 24 soatlik oynada ishlaydi va `createdAt` bo'yicha
     * filtrlaydi — indekssiz bu jadval o'sgach sekinlashadi.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PWO_PARTNER_CREATED"
      ON "integration_schema"."partner_webhook_outbox" ("partner_id", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_PWO_PARTNER_CREATED"`,
    );
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partner_webhook_outbox"
        DROP COLUMN IF EXISTS "duration_ms"
    `);
  }
}
