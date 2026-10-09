import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (ePpLHPX2) `logistics_schema.outbox_events` — logistics-service endi
 * transactional outbox orqali bildirishnoma yuboradi
 * (`notification.dispatch`, `logistics.batch_arrived`: pochta manzil filialga
 * qabul qilindi).
 *
 * Har migratsiya bir marta `order_schema.migrations` da yoziladi va o'z
 * sxemasini qattiq ko'rsatadi (1716000000012 / 1716000000053 bilan bir xil
 * naqsh): asl outbox migratsiyasi (1713800000000) faqat ulanish sxemasida
 * jadval yaratgan. finance_schema da jadval allaqachon bor (1716000000012).
 *
 * Enqueue pochta holati yozuvi bilan BITTA tranzaksiyada — rollback bo'lsa
 * bildirishnoma ketmaydi.
 *
 * ⚠️ DEPLOY TARTIBI: shu migratsiya logistics-service yangi versiyasidan
 * OLDIN ishga tushirilsin — aks holda OutboxPublisher har soniyada
 * "relation does not exist" xatosini loglaydi (pochta qabul qilish baribir
 * ishlaydi: bildirishnoma yozilmasa pochta bildirishnomasiz saqlanadi).
 */
export class CreateLogisticsOutboxEvents1716000000064 implements MigrationInterface {
  name = 'CreateLogisticsOutboxEvents1716000000064';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "logistics_schema"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "logistics_schema"."outbox_events" (
        "id" BIGSERIAL PRIMARY KEY,
        "target" VARCHAR(64) NOT NULL,
        "pattern" VARCHAR(128) NOT NULL,
        "payload" JSONB NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "last_error" TEXT,
        "scheduled_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "published_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_LOGISTICS_OUTBOX_DUE"
      ON "logistics_schema"."outbox_events" ("status", "scheduled_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_LOGISTICS_OUTBOX_TARGET"
      ON "logistics_schema"."outbox_events" ("target")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "logistics_schema"."outbox_events" CASCADE`,
    );
  }
}
