import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * utIffRFx (4-band) — kargo to'lovining ortiqcha qismi hamkor bo'yicha
 * "oldindan to'lov" (AVANS) bo'lib yuritiladi va KEYINGI to'lovda avtomatik
 * qarzlarga (FIFO) qo'llanadi.
 *
 *   `advance_applied` — shu to'lov qarz yopishda AVVALGI to'lovlardan qolgan
 *                       avansdan qancha ishlatgani (≥ 0).
 *
 * Hamkor avansi (integration-service `computeRemittanceAdvance`):
 *   avans = Σ faol, kuzatiladigan to'lovlar
 *             (max(unapplied_amount, 0) − advance_applied)
 * "Kuzatiladigan" — `advance_applied IS NOT NULL`, ya'ni shu migratsiyadan
 * KEYIN yozilgan to'lov (har yangi yozuvda 0 yoki undan katta).
 *
 * ⚠️ Faqat yangi NULLABLE ustun — mavjud qatorlar TO'LDIRILMAYDI va
 * o'zgartirilmaydi. Eski yozuvlar (NULL) avansga KIRMAYDI: ularning
 * `unapplied_amount` i operatorga "qoldiqni tekshiring" ogohlantirishi bilan
 * ko'rsatilgan va qo'lda hal qilingan bo'lishi mumkin — avtomatik qayta
 * ishlatish pulni ikki marta hisoblashi mumkin edi. Ko'rib chiqilgan eski
 * qoldiqni avansga qo'shish — qo'lda SQL (hisobotda).
 */
export class ProviderRemittanceAdvance1716000000104 implements MigrationInterface {
  name = 'ProviderRemittanceAdvance1716000000104';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."provider_remittances"
        ADD COLUMN IF NOT EXISTS "advance_applied" NUMERIC(14,2) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."provider_remittances"
        DROP COLUMN IF EXISTS "advance_applied"
    `);
  }
}
