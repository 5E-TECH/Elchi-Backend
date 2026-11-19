import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * COURIER-SCAN (ega, 2026-11-17) — «kuryer skani = qabul»: eski qatorlar.
 *
 * Ilgari (6qypMFeT, d98de6d4) `scan-assign` kuryer skan bilan olgan
 * buyurtmani `on the road` (Yo'lda) qilib kuryerning SENT pochtasiga
 * qo'yardi — posilka kuryer qo'lida bo'lsa ham unga yana «Qabul qilish»
 * chiqardi, ro'yxat esa uni `isCourierScanTakenOrder` istisnosi bilan
 * «Kutilayotgan» ga qo'shardi. Endi skan darhol `waiting` (Kutilmoqda,
 * kuryerda) yozadi va istisno olib tashlandi. Bu migratsiya — deploy
 * paytida hamon `on the road` turgan shunday qatorlar uchun BIR MARTALIK
 * ko'chirish:
 *
 *  1. Buyurtmalar (`isCourierScanTakenOrder` sharti, aynan): o'chirilmagan,
 *     `on the road`, `holder_type = COURIER`, kuryer = ushlovchi kuryer =
 *     topshirishni yozgan (`last_handover_by`) — ya'ni kuryerning o'zi skan
 *     bilan olgan (menejer biriktirgan / jo'natilgan pochtada
 *     `last_handover_by` — xodim), `return_requested = false`, pochtasi shu
 *     kuryerning pochtasi → `waiting`. Kuryer, ushlovchi, pochta, pul
 *     ustunlari o'zgarmaydi (posilka allaqachon kuryer hisobida).
 *  2. Har ko'chirilgan buyurtmaga tarix qatori: `on the road → waiting`,
 *     amal `courier_scan_received`, tizim nomidan, izoh bilan.
 *  3. Kuryer pochtalari (haqiqiy kuryer, `sent`) — ichida `on the road`
 *     buyurtma qolmagan bo'lsa `received` (bo'sh «yo'ldagi» pochta
 *     qolmasin; kod ham shunday yopadi — LC-11). Bo'sh `branch_id` kuryer
 *     filiali bilan to'ldiriladi (migratsiya 1716000000202 qoidasi:
 *     faqat aniq bo'lsa).
 *
 * XAVFSIZLIK: pul, kassa, ushlovchi va pochta a'zoligi o'zgarmaydi; qidiruv
 * indeksi va hamkor webhook'i yuborilmaydi (keyingi holat o'zgarishi
 * yuboradi). Qayta yurgizish xatosiz: ikkinchi marta mos qator yo'q.
 * Jadval(lar) bo'lmasa — o'tkazib yuboriladi.
 *
 * DEPLOY OYNASI: migratsiya servislar qayta ishga tushishidan OLDIN yuradi —
 * shu oraliqda ESKI logistics-service yangi skanni hamon `on the road`
 * yozadi. Bunday qator yo'qolmaydi: `isCourierScanTakenOrder` istisnosi
 * (kuryer ro'yxati, tab sonlari, «kelmagan» taqiqi) shu sabab bir reliz
 * saqlanadi — u «Kutilayotgan» da chiqadi, «Sotish» / «Bekor qilish» o'zi
 * qabul qiladi, qayta skan ham qabul qiladi; faqat yorlig'i «Yo'lda» qoladi.
 * Hamma servis yangi kodda ishlay boshlagach shu SQL ni
 * (`COURIER_SCAN_TAKEN_TO_WAITING_UP_SQL`) psql bilan bir marta qayta
 * yurgizish mumkin — idempotent; keyingi relizda istisno olib tashlanadi.
 *
 * down(): hech narsa qilmaydi — `waiting` buyurtma keyin sotilgan bo'lishi
 * mumkin, uni `on the road` ga qaytarish pulni buzadi.
 */
export const COURIER_SCAN_TAKEN_TO_WAITING_UP_SQL = `
      DO $$
      DECLARE
        from_status_type text;
        to_status_type text;
        closed_post_ids bigint[];
      BEGIN
        IF to_regclass('"order_schema"."orders"') IS NULL
          OR to_regclass('"order_schema"."order_tracking"') IS NULL
          OR to_regclass('"logistics_schema"."posts"') IS NULL THEN
          RETURN;
        END IF;

        -- Tarix ustunlarining enum turlari — har biri alohida (orders bilan ham,
        -- bir-biri bilan ham bir xil bo'lmasligi mumkin: Postgres ikki xil enum
        -- orasida cast qilmaydi).
        SELECT format('%I.%I', c."udt_schema", c."udt_name")
          INTO from_status_type
          FROM information_schema.columns c
         WHERE c."table_schema" = 'order_schema'
           AND c."table_name" = 'order_tracking'
           AND c."column_name" = 'from_status';
        SELECT format('%I.%I', c."udt_schema", c."udt_name")
          INTO to_status_type
          FROM information_schema.columns c
         WHERE c."table_schema" = 'order_schema'
           AND c."table_name" = 'order_tracking'
           AND c."column_name" = 'to_status';

        -- 1–2. Skan bilan olingan ON_THE_ROAD → WAITING + tarix qatori
        -- (bitta so'rov: o'zgargan qatorlargagina tarix yoziladi).
        EXECUTE format(
          $sql$
          WITH moved AS (
            UPDATE "order_schema"."orders" o
               SET "status" = 'waiting'
              FROM "logistics_schema"."posts" p
             WHERE p."id" = o."post_id"
               AND p."courier_id" = o."holder_courier_id"
               AND o."is_deleted" = false
               AND o."status"::text = 'on the road'
               AND upper(COALESCE(o."holder_type"::text, '')) = 'COURIER'
               AND o."holder_courier_id" IS NOT NULL
               AND o."courier_id" = o."holder_courier_id"
               AND o."last_handover_by" = o."holder_courier_id"
               AND COALESCE(o."return_requested", false) = false
            RETURNING o."id", o."post_id", o."courier_id"
          )
          INSERT INTO "order_schema"."order_tracking"
            ("order_id", "from_status", "to_status", "changed_by",
             "changed_by_role", "action", "description", "metadata", "note")
          SELECT m."id", %1$L::%2$s, %3$L::%4$s, 'system', 'system',
                 'courier_scan_received',
                 'Kuryer skan bilan olgan buyurtma «Kutilmoqda» holatiga o''tkazildi (skan = qabul)',
                 jsonb_build_object(
                   'post_id', m."post_id"::text,
                   'courier_id', m."courier_id"::text,
                   'source', 'courier_scan_accepts_migration'
                 ),
                 'COURIER-SCAN 2026-11-17: skan bilan olingan ON_THE_ROAD qator WAITING ga ko''chirildi'
            FROM moved m
          $sql$,
          'on the road',
          from_status_type,
          'waiting',
          to_status_type
        );

        -- 3. Yo'ldagi buyurtmasi qolmagan SENT kuryer pochtalari yopiladi.
        WITH closed AS (
          UPDATE "logistics_schema"."posts" p
             SET "status" = 'received'
           WHERE p."status"::text = 'sent'
             AND p."courier_id" IS NOT NULL
             AND p."courier_id" <> 0
             AND NOT EXISTS (
               SELECT 1 FROM "order_schema"."orders" o
                WHERE o."post_id" = p."id"
                  AND o."is_deleted" = false
                  AND o."status"::text = 'on the road'
             )
          RETURNING p."id"
        )
        SELECT array_agg("id") INTO closed_post_ids FROM closed;

        -- Ega qarori 4: RECEIVED kuryer pochtasi — kuryer filialida
        -- (1716000000202 qoidasi; faqat bo'sh va aniq bo'lsa).
        IF closed_post_ids IS NOT NULL
          AND to_regclass('"branch_schema"."branch_users"') IS NOT NULL THEN
          UPDATE "logistics_schema"."posts" p
             SET "branch_id" = CASE
                   WHEN s."branch_count" = 1 THEN s."any_branch_id"
                   ELSE s."active_courier_branch_id"
                 END
            FROM (
              SELECT u."user_id",
                     COUNT(DISTINCT u."branch_id") AS "branch_count",
                     MIN(u."branch_id") AS "any_branch_id",
                     COUNT(*) FILTER (WHERE NOT u."is_deleted") AS "active_count",
                     MIN(u."branch_id") FILTER (
                       WHERE NOT u."is_deleted"
                         AND upper(u."role"::text) = 'COURIER'
                     ) AS "active_courier_branch_id",
                     MIN(GREATEST(u."createdAt", u."updatedAt")) FILTER (
                       WHERE NOT u."is_deleted"
                         AND upper(u."role"::text) = 'COURIER'
                     ) AS "active_courier_since"
                FROM "branch_schema"."branch_users" u
               GROUP BY u."user_id"
              HAVING bool_or(upper(u."role"::text) = 'COURIER')
            ) s
           WHERE s."user_id" = p."courier_id"
             AND p."id" = ANY (closed_post_ids)
             AND p."branch_id" IS NULL
             AND (
               s."branch_count" = 1
               OR (
                 s."active_count" = 1
                 AND s."active_courier_branch_id" IS NOT NULL
                 AND s."active_courier_since" <= p."createdAt"
               )
             );
        END IF;
      END $$;
    `;

export class CourierScanTakenToWaiting1716000000240 implements MigrationInterface {
  name = 'CourierScanTakenToWaiting1716000000240';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(COURIER_SCAN_TAKEN_TO_WAITING_UP_SQL);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh: `waiting` ga o'tgan buyurtma keyin sotilgan / bekor
    // qilingan bo'lishi mumkin (yuqoridagi izoh).
  }
}
