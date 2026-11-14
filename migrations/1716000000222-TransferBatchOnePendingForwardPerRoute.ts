import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filial paketi (FORWARD) — bitta yo'nalishga bitta umumiy PENDING paket
 * (Dilshod 2026-11-14, /batches: «paketlar hamma viloyatniki umumiy 1 ta
 * bo'lishi kerak, alohida-alohida emas»).
 *
 * Ilgari filialdan HQ ga har VILOYATga alohida paket ochilardi (B-20 Jizzax,
 * B-21 Toshkent shahri …). Endi kod (`createBranchTransferBatches`) bitta
 * yo'nalishga (manba → manzil) bitta PENDING paket ochadi, viloyatga
 * bog'lamaydi (`target_region_id = NULL`).
 *
 * 1. `target_region_id` — NULL bo'la oladi (umumiy paket).
 * 2. Mavjud PENDING FORWARD paketlar bir yo'nalishda bittadan ko'p bo'lsa —
 *    ENG ESKISIGA birlashtiriladi: qatorlar (`branch_transfer_batch_items`) va
 *    buyurtmalarning `current_batch_id` si o'sha paketga o'tadi, soni va summasi
 *    qayta hisoblanadi, viloyati NULL. Bo'shagan paketlar o'chiriladi
 *    (`is_deleted`, bekor qilish emas — buyurtmalari yo'qolmagan), ikkala
 *    tomonga tarix yoziladi. Faqat jo'natilmagan (PENDING) paketlar —
 *    SENT / RECEIVED / CANCELLED tegilmaydi.
 * 3. Bazada kafolat: bitta yo'nalishga bitta PENDING FORWARD paket
 *    (`UQ_BRANCH_TRANSFER_BATCHES_PENDING_FORWARD_ROUTE`, qisman indeks).
 *
 * Birlashtirib bo'lmaydigan qator (bir buyurtma ikki paketda) qolsa,
 * migratsiya to'xtaydi — deploy zaxiradan qaytadi, ma'lumot buzilmaydi.
 */
export class TransferBatchOnePendingForwardPerRoute1716000000222 implements MigrationInterface {
  name = 'TransferBatchOnePendingForwardPerRoute1716000000222';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."branch_transfer_batches"
        ALTER COLUMN "target_region_id" DROP NOT NULL
    `);

    // Birlashtiriladigan paket → qoladigan (eng eski) paket.
    await queryRunner.query(`DROP TABLE IF EXISTS "_btb_forward_merge"`);
    await queryRunner.query(`
      CREATE TEMP TABLE "_btb_forward_merge" AS
      SELECT ranked.id AS merged_id, ranked.keeper_id
        FROM (
          SELECT b.id,
                 first_value(b.id) OVER (
                   PARTITION BY b.source_branch_id, b.destination_branch_id
                   ORDER BY b."createdAt", b.id
                 ) AS keeper_id
            FROM "order_schema"."branch_transfer_batches" b
           WHERE b.status = 'PENDING'
             AND b.direction = 'FORWARD'
             AND b.is_deleted = false
        ) ranked
       WHERE ranked.id <> ranked.keeper_id
    `);

    await queryRunner.query(`
      UPDATE "order_schema"."branch_transfer_batch_items" item
         SET batch_id = m.keeper_id, "updatedAt" = now()
        FROM "_btb_forward_merge" m
       WHERE item.batch_id = m.merged_id
         AND item.is_deleted = false
         AND NOT EXISTS (
           SELECT 1 FROM "order_schema"."branch_transfer_batch_items" kept
            WHERE kept.batch_id = m.keeper_id AND kept.order_id = item.order_id
         )
    `);
    const stuck = (await queryRunner.query(`
      SELECT count(*)::int AS n
        FROM "order_schema"."branch_transfer_batch_items" item
        JOIN "_btb_forward_merge" m ON m.merged_id = item.batch_id
       WHERE item.is_deleted = false
    `)) as Array<{ n: number }>;
    if (Number(stuck[0]?.n ?? 0) > 0) {
      throw new Error(
        `Filial paketlarini birlashtirib bo'lmadi: ${stuck[0].n} ta qator ikkala paketda ham bor`,
      );
    }

    await queryRunner.query(`
      UPDATE "order_schema"."orders" o
         SET current_batch_id = m.keeper_id
        FROM "_btb_forward_merge" m
       WHERE o.current_batch_id = m.merged_id
    `);

    await queryRunner.query(`
      UPDATE "order_schema"."branch_transfer_batches" b
         SET order_count = totals.n,
             total_price = totals.total,
             target_region_id = NULL,
             "updatedAt" = now()
        FROM (
          SELECT k.keeper_id,
                 count(item.id)::int AS n,
                 coalesce(sum(item.snapshot_price), 0) AS total
            FROM (SELECT DISTINCT keeper_id FROM "_btb_forward_merge") k
            LEFT JOIN "order_schema"."branch_transfer_batch_items" item
              ON item.batch_id = k.keeper_id
             AND item.is_deleted = false
             AND item.sent_at IS NULL
           GROUP BY k.keeper_id
        ) totals
       WHERE b.id = totals.keeper_id
    `);

    await queryRunner.query(`
      INSERT INTO "order_schema"."branch_transfer_batch_history"
             (batch_id, user_id, action, notes)
      SELECT m.keeper_id, 0, 'CREATED',
             '[STEP] BATCHES_MERGED #' || string_agg(m.merged_id::text, ', #' ORDER BY m.merged_id)
        FROM "_btb_forward_merge" m
       GROUP BY m.keeper_id
    `);
    await queryRunner.query(`
      INSERT INTO "order_schema"."branch_transfer_batch_history"
             (batch_id, user_id, action, notes)
      SELECT m.merged_id, 0, 'CANCELLED',
             '[STEP] MERGED_INTO #' || m.keeper_id::text
        FROM "_btb_forward_merge" m
    `);
    await queryRunner.query(`
      UPDATE "order_schema"."branch_transfer_batches" b
         SET is_deleted = true,
             order_count = 0,
             total_price = 0,
             "updatedAt" = now()
        FROM "_btb_forward_merge" m
       WHERE b.id = m.merged_id
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "_btb_forward_merge"`);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_BRANCH_TRANSFER_BATCHES_PENDING_FORWARD_ROUTE"
        ON "order_schema"."branch_transfer_batches"
        ("source_branch_id", "destination_branch_id")
        WHERE "status" = 'PENDING' AND "direction" = 'FORWARD' AND "is_deleted" = false
    `);
  }

  /**
   * ⚠️ Birlashtirilgan paketlar qayta ajratilmaydi (tarixda `MERGED_INTO`).
   * Umumiy paket (`target_region_id = NULL`) qolgan bo'lsa ustun NULL bo'la
   * oladigan holicha qoladi.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."UQ_BRANCH_TRANSFER_BATCHES_PENDING_FORWARD_ROUTE"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM "order_schema"."branch_transfer_batches"
           WHERE target_region_id IS NULL
        ) THEN
          ALTER TABLE "order_schema"."branch_transfer_batches"
            ALTER COLUMN "target_region_id" SET NOT NULL;
        END IF;
      END $$
    `);
  }
}
