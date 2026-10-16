import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (A1HzKEby #3) Inbox retention cron'i uchun QISMAN indeks.
 *
 * Kunlik so'rov: `WHERE is_read = $1 AND priority <> 'critical' AND
 * "createdAt" < $2 LIMIT 5000`. Mavjud indekslar `recipient_id` bilan
 * boshlanadi (IDX_NOTIF_RECIPIENT_READ / _CREATED) — ular bu so'rovga
 * yaramaydi va katta jadvalda har partiya to'liq skan bo'lardi.
 * `priority = 'critical'` qatorlar HECH QACHON o'chirilmaydi — indeksga
 * ham tushmaydi.
 *
 * FAQAT SXEMA: ma'lumot o'zgarmaydi (backfill/DELETE yo'q). Cron sukut
 * bo'yicha O'CHIQ (NOTIF_RETENTION_ENABLED=false).
 *
 * `CONCURRENTLY` ISHLATILMAYDI (1716000000035/058/092 bilan bir xil sabab):
 * TypeORM migratsiyasi tranzaksiyada. `notifications` — kichik/o'rta jadval;
 * CREATE INDEX qisqa SHARE qulfi oladi (o'qish to'xtamaydi). `IF NOT EXISTS`
 * — qayta ishga tushirish xavfsiz.
 */
export class NotificationRetentionIndex1716000000108 implements MigrationInterface {
  name = 'NotificationRetentionIndex1716000000108';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIF_RETENTION"
        ON "notification_schema"."notifications" ("is_read", "createdAt")
        WHERE "priority" <> 'critical'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "notification_schema"."IDX_NOTIF_RETENTION"`,
    );
  }
}
