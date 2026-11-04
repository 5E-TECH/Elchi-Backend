import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * hwTkXsGi: qo'shimcha xarajat so'rovlari «kutilmoqda» bo'lib osilib qolmaydi.
 *
 * Kod endi so'rovni yopadi: amal haqiqatda bajarilganda, orqaga qaytarishda va
 * yangi so'rov eskisini almashtirganda — `void`; tasdiqlangan xarajat orqaga
 * qaytarilganda — `reversed`. «Tasdiqlandi» sotuv bilan bitta tranzaksiyada
 * yoziladi. Bu migratsiya ESKI kod qoldirgan qatorlarni tuzatadi:
 *
 *  1. `closed_reason`, `closed_at`, `closed_by_user_id` ustunlari.
 *  2. Buyurtmasi endi «kutilmoqda» emas (yoki o'chirilgan) `pending` → `void`.
 *  3. «Tasdiqlandi», lekin buyurtma hali «kutilmoqda» va amal yozilmagan
 *     (claim commit bo'lib, sotuv yo'q qolgan holat) → `pending`, market qayta
 *     tasdiqlaydi. «Amal yozilmagan» = so'rovdan keyin `order_tracking` da
 *     shu amalning o'tishi yo'q VA finance'da shu tasdiq tokeni
 *     (`req:extra-cost-approval:<id>`) bilan kassa yozuvi yo'q — aks holda
 *     qayta tasdiq o'sha tokenni qayta ishlatib, finance kassa oyoqlarini
 *     jimgina tashlab yuborardi. So'rovdan keyin buyurtma holati o'zgargan
 *     bo'lsa (masalan sotilib, orqaga qaytarilgan) — qayta ochilmaydi, `void`:
 *     kodning tasdiq darvozasi ham shunday so'rovni yopadi, qayta ochish esa
 *     `createdAt` ni yangilab, o'sha izni o'chirib yuborardi (eski amal eski
 *     xarajat bilan qayta bajarilardi). Shu buyurtmada boshqa ochiq so'rov
 *     bo'lsa — kuryerning keyingi niyati ustun, eskisi `void`. Qaytgan so'rov
 *     yangi ochilgandek: `createdAt = now()` (avtomatik tasdiq muddati va
 *     darvoza shundan sanaladi), qaror maydonlari tozalanadi.
 *  4. Bitta buyurtmada bir nechta `pending` — eng yangisi qoladi, qolgani `void`.
 *  5. Partial unique indeks: bitta buyurtmada bittadan ortiq ochiq so'rov yo'q.
 *
 * Nechta qator o'zgargani db-prepare logiga yoziladi. Qayta yurgizish hech
 * narsani o'zgartirmaydi. Jadval yo'q — hech narsa qilinmaydi.
 * down(): indeks va ustunlar olib tashlanadi; `void`/`reversed` qatorlar
 * holicha qoladi (asl holatni tiklab bo'lmaydi).
 */
export class ExtraCostApprovalVoidReversed1716000000206 implements MigrationInterface {
  name = 'ExtraCostApprovalVoidReversed1716000000206';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [table] = (await queryRunner.query(
      `SELECT to_regclass('"order_schema"."order_extra_cost_approvals"') IS NOT NULL AS "exists"`,
    )) as Array<{ exists: boolean }>;
    if (!table?.exists) return;

    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
        ADD COLUMN IF NOT EXISTS "closed_reason" text NULL,
        ADD COLUMN IF NOT EXISTS "closed_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "closed_by_user_id" bigint NULL
    `);

    const count = (rows: unknown): number =>
      Array.isArray(rows) && Array.isArray(rows[0])
        ? rows[0].length
        : Array.isArray(rows)
          ? rows.length
          : 0;

    // 2. Buyurtmasi endi «kutilmoqda» emas — so'rov osilib qolgan.
    const voidedNotWaiting = await queryRunner.query(`
      UPDATE "order_schema"."order_extra_cost_approvals" a
         SET "status" = 'void',
             "closed_reason" = 'Buyurtma endi «kutilmoqda» holatida emas — eski so''rov yopildi',
             "closed_at" = now(),
             "updatedAt" = now()
       WHERE a."status" = 'pending'
         AND a."is_deleted" = false
         AND NOT EXISTS (
           SELECT 1 FROM "order_schema"."orders" o
            WHERE o."id" = a."order_id"
              AND o."is_deleted" = false
              AND o."status"::text = 'waiting'
         )
      RETURNING a."id"
    `);

    // 3. «Tasdiqlandi», amal yozilmagan (C holati).
    const financeHistory = (
      (await queryRunner.query(
        `SELECT to_regclass('"finance_schema"."cashbox_history"') IS NOT NULL AS "exists"`,
      )) as Array<{ exists: boolean }>
    )[0]?.exists;
    const noFinanceLegs = financeHistory
      ? `AND NOT EXISTS (
           SELECT 1 FROM "finance_schema"."cashbox_history" ch
            WHERE ch."dedup_epoch" = 'req:extra-cost-approval:' || a."id"::text
         )`
      : '';
    const unexecuted = (await queryRunner.query(`
      SELECT a."id"::text AS "id",
             EXISTS (
               SELECT 1 FROM "order_schema"."order_tracking" t2
                WHERE t2."order_id" = a."order_id"
                  AND t2."created_at" > a."createdAt"
                  AND t2."from_status"::text IS DISTINCT FROM t2."to_status"::text
             ) AS "stale"
        FROM "order_schema"."order_extra_cost_approvals" a
        JOIN "order_schema"."orders" o
          ON o."id" = a."order_id"
         AND o."is_deleted" = false
         AND o."status"::text = 'waiting'
       WHERE a."status" = 'approved'
         AND a."is_deleted" = false
         AND NOT EXISTS (
           SELECT 1 FROM "order_schema"."order_tracking" t
            WHERE t."order_id" = a."order_id"
              AND t."created_at" >= a."createdAt"
              AND t."from_status"::text = 'waiting'
              AND t."to_status"::text = ANY (
                CASE WHEN a."action" = 'cancel'
                     THEN ARRAY['cancelled']
                     ELSE ARRAY['sold', 'paid', 'partly_paid']
                END
              )
         )
         ${noFinanceLegs}
    `)) as Array<{ id: string; stale: boolean }>;
    // 3a. So'rovdan keyin buyurtma holati o'zgargan — eskirgan, `void`
    // (darvoza `extraCostStatusChangedSince` bilan bir xil qoida).
    const staleIds = unexecuted.filter((row) => row.stale).map((row) => row.id);
    const unexecutedIds = unexecuted
      .filter((row) => !row.stale)
      .map((row) => row.id);
    let voidedStale: unknown = [];
    if (staleIds.length) {
      voidedStale = await queryRunner.query(
        `
        UPDATE "order_schema"."order_extra_cost_approvals" a
           SET "status" = 'void',
               "closed_reason" = 'So''rov ochilgandan keyin buyurtma holati o''zgargan — eski tasdiq bajarilmagan edi, qayta ochilmadi',
               "closed_at" = now(),
               "updatedAt" = now()
         WHERE a."id" = ANY ($1::bigint[])
           AND a."status" = 'approved'
        RETURNING a."id"
        `,
        [staleIds],
      );
    }
    let voidedSuperseded: unknown = [];
    let reopened: unknown = [];
    if (unexecutedIds.length) {
      // 3b. Shu buyurtmada boshqa ochiq so'rov (yoki keyinroq ochilgan
      // boshqa C holati) bor — eng yangi niyat qoladi, eskisi `void`.
      voidedSuperseded = await queryRunner.query(
        `
        UPDATE "order_schema"."order_extra_cost_approvals" a
           SET "status" = 'void',
               "closed_reason" = 'Yangi so''rov bilan almashtirildi — eski tasdiq bajarilmagan edi',
               "closed_at" = now(),
               "updatedAt" = now()
         WHERE a."id" = ANY ($1::bigint[])
           AND EXISTS (
             SELECT 1 FROM "order_schema"."order_extra_cost_approvals" b
              WHERE b."order_id" = a."order_id"
                AND b."is_deleted" = false
                AND b."id" <> a."id"
                AND (
                  b."status" = 'pending'
                  OR (
                    b."id" = ANY ($1::bigint[])
                    AND (b."createdAt", b."id") > (a."createdAt", a."id")
                  )
                )
           )
        RETURNING a."id"
        `,
        [unexecutedIds],
      );
      // 3c. Qolgani — qayta `pending`, market qayta tasdiqlaydi.
      reopened = await queryRunner.query(
        `
        UPDATE "order_schema"."order_extra_cost_approvals" a
           SET "status" = 'pending',
               "decided_by_user_id" = NULL,
               "decided_at" = NULL,
               "decision_comment" = NULL,
               "auto_approved" = false,
               "reminder_sent_at" = NULL,
               "createdAt" = now(),
               "updatedAt" = now()
         WHERE a."id" = ANY ($1::bigint[])
           AND a."status" = 'approved'
        RETURNING a."id"
        `,
        [unexecutedIds],
      );
    }

    // 4. Bir buyurtmada bir nechta ochiq so'rov — eng yangisi qoladi.
    const voidedDuplicates = await queryRunner.query(`
      UPDATE "order_schema"."order_extra_cost_approvals" a
         SET "status" = 'void',
             "closed_reason" = 'Yangi so''rov bilan almashtirildi — eski so''rov yopildi',
             "closed_at" = now(),
             "updatedAt" = now()
       WHERE a."status" = 'pending'
         AND a."is_deleted" = false
         AND EXISTS (
           SELECT 1 FROM "order_schema"."order_extra_cost_approvals" b
            WHERE b."order_id" = a."order_id"
              AND b."status" = 'pending'
              AND b."is_deleted" = false
              AND (b."createdAt", b."id") > (a."createdAt", a."id")
         )
      RETURNING a."id"
    `);

    // 5. Bitta buyurtmada bitta ochiq so'rov.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ORDER_EXTRA_COST_APPROVAL_PENDING"
        ON "order_schema"."order_extra_cost_approvals" ("order_id")
        WHERE "status" = 'pending' AND "is_deleted" = false
    `);

    console.log(
      `[migration 206] extra-cost: void (buyurtma kutilmoqda emas) ${count(voidedNotWaiting)}, ` +
        `void (eskirgan, bajarilmagan tasdiq) ${count(voidedStale)}, ` +
        `void (almashtirilgan, bajarilmagan tasdiq) ${count(voidedSuperseded)}, ` +
        `qayta pending (tasdiq yozilib sotuv yo'q) ${count(reopened)}, ` +
        `void (takroriy ochiq so'rov) ${count(voidedDuplicates)}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."UQ_ORDER_EXTRA_COST_APPROVAL_PENDING"`,
    );
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "order_schema"."order_extra_cost_approvals"
        DROP COLUMN IF EXISTS "closed_by_user_id",
        DROP COLUMN IF EXISTS "closed_at",
        DROP COLUMN IF EXISTS "closed_reason"
    `);
  }
}
