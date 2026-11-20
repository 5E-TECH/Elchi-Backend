import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filial (kassa) Telegram guruhi, 3/3 — `shift_report_deliveries`:
 *  - `recipient_kind` ga `branch` (filial guruhi, `recipient_id` — filial id)
 *    va `branch_manager` (menejerning shaxsiy chati) qo'shiladi;
 *  - unikal kalit (`UQ_SHIFT_REPORT_DELIVERY_KIND`) endi `recipient_kind` ni
 *    ham oladi — filial id 12 va kuryer id 12 qatori to'qnashmasin (eski
 *    kalit bilan unikal qatorlar yangisi bilan ham unikal).
 */
export class ShiftReportDeliveryBranchKinds1716000000249 implements MigrationInterface {
  name = 'ShiftReportDeliveryBranchKinds1716000000249';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ previous }] = (await queryRunner.query(
      `SELECT current_setting('lock_timeout') AS previous`,
    )) as Array<{ previous: string }>;
    await queryRunner.query(`SELECT set_config('lock_timeout', '5s', true)`);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        DROP CONSTRAINT IF EXISTS "CHK_SHIFT_REPORT_DELIVERY_KIND"
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        ADD CONSTRAINT "CHK_SHIFT_REPORT_DELIVERY_KIND" CHECK ("recipient_kind" IN
          ('superadmin','courier','market','branch','branch_manager'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SHIFT_REPORT_DELIVERY_KIND"
        ON "finance_schema"."shift_report_deliveries"
           ("shift_id", "round", "recipient_kind", "recipient_id", "channel")
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_SHIFT_REPORT_DELIVERY"`,
    );
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
      previous,
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "finance_schema"."shift_report_deliveries"
       WHERE "recipient_kind" IN ('branch','branch_manager')
    `);
    // Yangi kalit bilan yozilgan (turli tur, bir xil id) jurnal qatorlari —
    // eski kalitga sig'maydi: birinchisi qoladi.
    await queryRunner.query(`
      DELETE FROM "finance_schema"."shift_report_deliveries" a
       USING "finance_schema"."shift_report_deliveries" b
       WHERE a."shift_id" = b."shift_id" AND a."round" = b."round"
         AND a."recipient_id" = b."recipient_id" AND a."channel" = b."channel"
         AND a."id" > b."id"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SHIFT_REPORT_DELIVERY"
        ON "finance_schema"."shift_report_deliveries"
           ("shift_id", "round", "recipient_id", "channel")
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_SHIFT_REPORT_DELIVERY_KIND"`,
    );
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        DROP CONSTRAINT IF EXISTS "CHK_SHIFT_REPORT_DELIVERY_KIND"
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        ADD CONSTRAINT "CHK_SHIFT_REPORT_DELIVERY_KIND" CHECK ("recipient_kind" IN
          ('superadmin','courier','market'))
    `);
  }
}
