import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-5 (#702 review) — AI maslahatchi R2/R4/R5 epizodlari: kassa ichida vaqt
 * tartibi uchun `finance_schema.cashbox_history ("cashbox_id", "createdAt", "id")`.
 * Raqam orkestr bilan kelishilgan (243; 241 — #706, 242 — #707).
 *
 * `episodes()` har kassa uchun «oxirgi `balance_after <= 0` qatori» (`zr`) va
 * «undan keyingi birinchi qator» (`rs`) ni `(createdAt, id)` tartibida
 * qidiradi. Bu indekssiz rejalashtiruvchi `IDX_CASHBOX_HISTORY_CREATED_AT`
 * ni jadval boshidan o'qib, har kassa uchun `cashbox_id` bo'yicha filtrlardi
 * (kassalar × butun tarix — kvadratik). O'lchov (1.1M qator, vaqt
 * tartibida): 100 kuryer × 730 kun 41–48 s → ~1 s; 50 kuryer + 50 market
 * 20–26 s → ~1.3 s (4 yadro, yuklama ostida).
 *
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. `CONCURRENTLY` yo'q: production
 * kutilgan migratsiyalarni BITTA tranzaksiyada yurgizadi (scripts/db-prepare.ts).
 * ⚠️ Indeks qurilishi davomida `cashbox_history` ga yozish kutadi (SHARE qulf;
 * db-prepare bitta tranzaksiyasida — butun partiya commit'igacha). O'lchov:
 * 10M qator (1.26 GB heap, issiq kesh) — qurilish 8–11 s, indeks 387 MB;
 * shu vaqt davomida INSERT kutadi, SELECT kutmaydi. Relizda kam yuklamali
 * vaqtda, 241 bilan birga — 243 eng oxirida.
 * `lock_timeout` 5 s (187/191/196/214/241 kabi): ochiq pul yozuvi tranzaksiyasi
 * bo'lsa DDL uzoq kutmaydi (aks holda keyingi barcha yozuvlar navbatga
 * turardi) — migratsiya yiqiladi, qayta yurgiziladi.
 * Pulga va ma'lumotga tegmaydi. down(): indeks olib tashlanadi.
 */
export class CashboxHistoryCashboxCreatedIndex1716000000243 implements MigrationInterface {
  name = 'CashboxHistoryCashboxCreatedIndex1716000000243';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_CASHBOX_CREATED"
        ON "finance_schema"."cashbox_history" ("cashbox_id", "createdAt", "id")
    `);
    await restore();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DROP INDEX — ACCESS EXCLUSIVE: ham shu chegara bilan.
    const restore = await this.lockTimeout(queryRunner);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_CASHBOX_CREATED"`,
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
