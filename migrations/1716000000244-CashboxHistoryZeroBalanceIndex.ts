import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-5 (#702 perf) — AI maslahatchi R2/R4/R5 epizodlari: kassaning oxirgi
 * `balance_after <= 0` qatori (`zr`) uchun QISMAN indeks
 * `finance_schema.cashbox_history ("cashbox_id", "createdAt", "id")
 * WHERE balance_after <= 0 AND is_deleted = false`.
 * Raqam: 243 (#702, `IDX_CASHBOX_HISTORY_CASHBOX_CREATED`) dan keyin; 243
 * ga tegilmaydi (u avval merge bo'lishi mumkin).
 *
 * 243 indeksi bilan `zr` kassa tarixini oxiridan o'qib, birinchi
 * `balance_after <= 0` qatorigacha filtrlaydi: hech qachon nolga tushmagan
 * kassada — butun tarix (100 kuryer × 730 kun × 20 qator: har kassaga 11k
 * qator). Qisman indeksda har kassa uchun bitta qadam. Indeks faqat
 * `balance_after <= 0` qatorlarni saqlaydi (kichik).
 *
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. `CONCURRENTLY` yo'q: production
 * kutilgan migratsiyalarni BITTA tranzaksiyada yurgizadi (scripts/db-prepare.ts).
 * ⚠️ Qurilish butun jadvalni o'qiydi; shu vaqt davomida `cashbox_history` ga
 * yozish kutadi (SHARE qulf; db-prepare bitta tranzaksiyasida — butun
 * partiya commit'igacha), o'qish kutmaydi. Relizda kam yuklamali vaqtda,
 * 240–244 bitta tranzaksiyada — 244 eng oxirida.
 * `lock_timeout` 5 s (187/191/196/214/241/243 kabi): ochiq pul yozuvi
 * tranzaksiyasi bo'lsa DDL uzoq kutmaydi — migratsiya yiqiladi, qayta yurgiziladi.
 * Pulga va ma'lumotga tegmaydi. down(): indeks olib tashlanadi.
 */
export class CashboxHistoryZeroBalanceIndex1716000000244 implements MigrationInterface {
  name = 'CashboxHistoryZeroBalanceIndex1716000000244';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_ZERO_BAL"
        ON "finance_schema"."cashbox_history" ("cashbox_id", "createdAt", "id")
        WHERE "balance_after" <= 0 AND "is_deleted" = false
    `);
    await restore();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DROP INDEX — ACCESS EXCLUSIVE: ham shu chegara bilan.
    const restore = await this.lockTimeout(queryRunner);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_ZERO_BAL"`,
    );
    await restore();
  }

  /** `lock_timeout` 5 s (tranzaksiya ichida, `is_local`); qaytaruvchi funksiya. */
  private async lockTimeout(
    queryRunner: QueryRunner,
  ): Promise<() => Promise<void>> {
    const [{ previous }] = (await queryRunner.query(
      `SELECT current_setting('lock_timeout') AS previous`,
    )) as Array<{ previous: string }>;
    await queryRunner.query(`SELECT set_config('lock_timeout', '5s', true)`);
    return async () => {
      await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
        previous,
      ]);
    };
  }
}
