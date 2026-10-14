import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * utIffRFx — kargo to'lovi (remittance) qoldig'i tarixda saqlanadi.
 *
 * Ilgari `provider_remittances` da faqat `amount` va `settled_count` bor edi:
 * FIFO sig'dira olmagan qoldiq (`unapplied_amount`) faqat javobda qaytardi va
 * hech qayerda qolmasdi — kassa +5 000 000, qarz daftari esa −3 200 000
 * yopilsa 1 800 000 ning izi yo'qolardi.
 *
 *   `settled_amount`   — shu to'lov bilan yopilgan qarz qatorlari yig'indisi;
 *   `unapplied_amount` — `amount − settled_amount` (musbat: qarzdan ortiq
 *                        kelgan; manfiy: aniq buyurtmalar ro'yxati to'lovdan
 *                        ko'p yopgan).
 *
 * ⚠️ Ikkalasi NULLABLE va mavjud qatorlar TO'LDIRILMAYDI (NULL = "noma'lum,
 * migratsiyadan oldingi yozuv"): tarixiy ma'lumot avtomatik o'zgartirilmaydi.
 * Kerak bo'lsa qo'lda to'ldirish SQL'i — hisobotda.
 */
export class ProviderRemittanceSettledUnapplied1716000000080 implements MigrationInterface {
  name = 'ProviderRemittanceSettledUnapplied1716000000080';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."provider_remittances"
        ADD COLUMN IF NOT EXISTS "settled_amount" NUMERIC(14,2) NULL,
        ADD COLUMN IF NOT EXISTS "unapplied_amount" NUMERIC(14,2) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."provider_remittances"
        DROP COLUMN IF EXISTS "unapplied_amount",
        DROP COLUMN IF EXISTS "settled_amount"
    `);
  }
}
