import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOT-3 (4-band) — guruh kartasi Telegram'ga TRANZAKSIYADAN TASHQARIDA
 * yuboriladi va kechikkan (429 → outbox navbati) karta ham keyin
 * tahrirlanadi:
 *
 *  - `telegram_order_cards.message_id` NULL bo'lishi mumkin — «yuborilmoqda»
 *    joy band qilish qatori (bitta guruhga bitta karta kafolati qisqa
 *    tranzaksiyada, tarmoq kutilmaydi);
 *  - `telegram_outbox.card_order_id` — navbatga tushgan karta xabari qaysi
 *    buyurtmaniki: outbox yuborganda `message_id` ni kartaga O'ZI yozadi
 *    (dead bo'lsa band qilish qatori o'chiriladi);
 *  - `telegram_order_cards.resync_pending` — karta navbatda turganda kelgan
 *    holat o'zgarishi: outbox yuborgach karta oxirgi holatga qayta
 *    sinxronlanadi (hodisa tashlanmaydi).
 *
 * QULF: `lock_timeout` 5 s (faqat shu tranzaksiyada) — deploy paytida eski
 * servis `telegram_order_cards` ni band qilib tursa, cheksiz kutib butun
 * trafikni to'xtatmaydi: deploy xato bilan to'xtaydi va qayta yurgiziladi.
 * Oxirida avvalgi qiymat tiklanadi (TypeORM migratsiyalarni bitta
 * tranzaksiyada yurgizadi — keyingilariga ta'sir qilmasin).
 *
 * XAVFSIZLIK: pulga tegmaydi. `DROP NOT NULL` / `ADD COLUMN … NULL` —
 * metama'lumot. Qayta yurgizish xatosiz. down(): band qilish qatorlari
 * (`message_id IS NULL`) o'chiriladi, NOT NULL tiklanadi, ustun o'chadi.
 */
export class TelegramOrderCardsPending1716000000191 implements MigrationInterface {
  name = 'TelegramOrderCardsPending1716000000191';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const previous = await this.limitLockWait(queryRunner);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_order_cards"
        ALTER COLUMN "message_id" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_order_cards"
        ADD COLUMN IF NOT EXISTS "resync_pending" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        ADD COLUMN IF NOT EXISTS "card_order_id" bigint NULL
    `);
    await this.restoreLockWait(queryRunner, previous);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const previous = await this.limitLockWait(queryRunner);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_order_cards"
        DROP COLUMN IF EXISTS "resync_pending"
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        DROP COLUMN IF EXISTS "card_order_id"
    `);
    await queryRunner.query(`
      DELETE FROM "notification_schema"."telegram_order_cards"
       WHERE "message_id" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_order_cards"
        ALTER COLUMN "message_id" SET NOT NULL
    `);
    await this.restoreLockWait(queryRunner, previous);
  }

  private async limitLockWait(queryRunner: QueryRunner): Promise<string> {
    const rows: Array<{ value: string }> = await queryRunner.query(
      `SELECT current_setting('lock_timeout') AS value`,
    );
    await queryRunner.query(`SELECT set_config('lock_timeout', '5s', true)`);
    return rows[0]?.value ?? '0';
  }

  private async restoreLockWait(
    queryRunner: QueryRunner,
    previous: string,
  ): Promise<void> {
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
      previous,
    ]);
  }
}
