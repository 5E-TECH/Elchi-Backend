import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (3PE0B03q) Kassa to'lovlarida "o'tkazma manbasi".
 *
 * Marketga / filialdan HQ'ga to'lovda "O'tkazma" (click) tanlansa UI
 * `source_user_id` (o'tkazmani qilgan xodim) yuborardi, gateway DTO'larida
 * esa bunday maydon yo'q edi — to'lov 400 bilan yiqilardi. Endi qiymat qabul
 * qilinadi va shu yangi ustunga yoziladi.
 *
 * Mavjud `source_user_id` ustuniga YOZILMAYDI: u kontragent (market / filial /
 * kuryer) va market/filial to'lov tarixi aynan shu ustun bo'yicha
 * filtrlanadi (`?source_user_id=<market>&cashbox_type=main`) — uni almashtirish
 * to'lovni market tarixidan yo'qotardi. Nullable, indekssiz (faqat audit).
 */
export class CashboxHistoryTransferSource1716000000079 implements MigrationInterface {
  name = 'CashboxHistoryTransferSource1716000000079';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        ADD COLUMN IF NOT EXISTS "transfer_source_user_id" bigint
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        DROP COLUMN IF EXISTS "transfer_source_user_id"
    `);
  }
}
