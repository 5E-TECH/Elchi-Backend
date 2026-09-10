import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G2 — hamkor webhook dedup indeksini QISMAN qiladi.
 *
 * MUAMMO. `IDX_PWO_DEDUP` to'liq UNIQUE `(partner_id, order_id, new_status)`
 * edi. Bu takroriy EMIT'ni to'sish uchun mo'ljallangan, lekin amalda takroriy
 * HODISA'ni ham to'sardi: buyurtma `sold` → operator rollback qildi →
 * `waiting` → kuryer qayta sotdi → `sold`. Ikkinchi `sold` allaqachon
 * yetkazilgan qatorga urilib "dublikat" deb JIMGINA tashlanardi — hamkor
 * tomonda buyurtma sotilmagan holatda qolib, pul desinxron bo'lardi.
 *
 * YECHIM. Indeks faqat UCHUVCHI qatorlar ustida unique bo'ladi:
 *   status IN ('pending', 'processing')
 * Shunda:
 *   - takroriy emit (RMQ redelivery) — hamon to'siladi;
 *   - status qayta yuz berishi — o'tadi, chunki oldingi qator `completed` /
 *     `permanently_failed` bo'lib indeksdan chiqadi.
 *
 * Qisman indeks to'liq indeksdan KO'RA BO'SHROQ, shuning uchun mavjud
 * ma'lumotda buzilish bo'lishi mumkin emas.
 *
 * Batafsil: docs/integrations/05-elchi.md §03 (G2), 07-pilot.md §5 mezon 6.
 */
export class PartnerWebhookDedupPending1716000000024
  implements MigrationInterface
{
  name = 'PartnerWebhookDedupPending1716000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_PWO_DEDUP";`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PWO_DEDUP"
      ON "integration_schema"."partner_webhook_outbox"
        ("partner_id", "order_id", "new_status")
      WHERE "status" IN ('pending', 'processing');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_PWO_DEDUP";`,
    );
    // DIQQAT: to'liq unique indeksni tiklash, agar bu migratsiyadan keyin
    // bir status QAYTA yuz bergan bo'lsa (aynan biz ruxsat bergan holat),
    // XATO bilan to'xtaydi. Bu ATAYLAB shunday: qatorlarni jimgina o'chirib
    // yuborgandan ko'ra, operator qaysi tarixni yo'qotayotganini bilib turishi
    // yaxshiroq. Rollback zarur bo'lsa dublikatlarni qo'lda hal qilish kerak.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PWO_DEDUP"
      ON "integration_schema"."partner_webhook_outbox"
        ("partner_id", "order_id", "new_status");
    `);
  }
}
