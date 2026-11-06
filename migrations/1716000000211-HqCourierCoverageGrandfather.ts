import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HQ kuryeri viloyat qoidasi (ega qarori 6, Trello anKpzwxk) — deploy
 * paytidagi «Eski filialda tugasin» BACKFILL'i:
 * `logistics_schema.district_coverage_exemptions` ga HQ qatorlari.
 *
 * Muammo: eski qoidada HQ cheklanmasdi — HQ kuryeri istalgan viloyat
 * buyurtmasini olardi (masalan HQ — Toshkent, buyurtma — Zangiota). Yangi
 * qoidada HQ kuryeri faqat HQ viloyati buyurtmasini oladi (403
 * `hq_courier_region_only`). Deploy paytida HQ kuryerida / HQ da turgan
 * shunday buyurtma, mijoz javob bermasa, qaytish tasdiqlangach (WAITING,
 * kuryersiz, filial HQ) boshqa HQ kuryeriga ham berilmasdi, filialga ham
 * jo'natib bo'lmasdi (WAITING → RECEIVED o'tishi yo'q, «Yangi pochtalar»
 * faqat RECEIVED, ko'chirish faqat NEW pochtadagini, FORWARD partiya faqat
 * NEW ni oladi) — yagona chiqish bekor qilish edi.
 *
 * Qaror («Eski filialda tugasin», #619 bilan bir xil): deploy PAYTIDA HQ
 * mas'ul bo'lgan va HQ viloyatidan tashqaridagi yo'ldagi / kutilayotgan
 * buyurtma HQ da tugaydi — (buyurtma, HQ) imtiyoz qatori yoziladi va HQ
 * kuryeriga berish to'sig'i (`assertOrdersServedByBranch`, HQ kuryeri
 * skani) uni o'tkazadi. Jo'natishga (dispatch) ta'sir qilmaydi.
 *
 * Qaysi buyurtmalar (migratsiya paytida):
 *  - o'chirilmagan (`is_deleted = false`, `deleted_at IS NULL`);
 *  - holati `on the road`, `waiting`, `waiting_customer`, shuningdek
 *    `cancelled` / `sold` (menejer yoki kuryer ularni WAITING ga qaytarishi
 *    mumkin — `rollbackOrderToWaiting`; #619 ochiq to'plami bilan bir xil)
 *    (`received` / `new` EMAS: HQ omboridagi jo'natilmagan buyurtma yangi
 *    qoidaga bo'ysunadi va o'z viloyati filialiga jo'natiladi);
 *  - mas'ul filial (`responsibleBranchId` bilan aynan bir xil): yo'ldagi
 *    (SENT) partiya — u borayotgan filial (`current_batch_id`); aks holda
 *    `holder_type` BRANCH/COURIER va `holder_branch_id` bor — o'sha filial;
 *    aks holda `branch_id` — va u o'chirilmagan HQ filiali (`type = 'HQ'`);
 *  - MARKET qo'lida emas;
 *  - XIZMAT viloyati (tuman qatori bor — `assigned_region ?? region_id`,
 *    yo'q — `orders.region_id`) HQ viloyatidan farq qiladi. HQ viloyati hali
 *    yo'q — hammasi (ops HQ viloyatini belgilagach ishlaydi).
 * `district_id` — buyurtmaning hozirgi tumani (to'siq imtiyozni faqat
 * buyurtma shu tumanda bo'lsa hisobga oladi; tumansiz — NULL).
 *
 * XAVFSIZLIK: pulga va buyurtmalarga tegmaydi — faqat imtiyoz qatorlari.
 * `ON CONFLICT (order_id, branch_id) DO NOTHING` — qayta yurgizish xatosiz
 * va dublikatsiz, mavjud qator (boshqa manba / bekor qilingan) tegilmaydi.
 * Jadval(lar) bo'lmasa — o'tkazib yuboriladi. `CONCURRENTLY` yo'q:
 * production kutilgan migratsiyalarni BITTA tranzaksiyada yurgizadi
 * (scripts/db-prepare.ts). down(): shu manbali qatorlar o'chiriladi.
 *
 * DEPLOY OYNASI: deploy migratsiyalarni servislar qayta qurilishidan OLDIN
 * yurgizadi (.github/workflows/deploy.yml: avval `migration-runner`, keyin
 * `up -d … $DEPLOY_SERVICES`; CI_IMAGES o'chiq bo'lsa serverda `--build`
 * ham — bir necha daqiqa). Shu oraliqda ESKI logistics-service HQ
 * kuryeriga hali istalgan viloyat buyurtmasini beradi — o'shanda berilgan
 * buyurtma imtiyoz qatorisiz qoladi (TypeORM 204 ni qayta yurgizmaydi).
 * Shuning uchun:
 *  - deploy'ni HQ kuryerlari buyurtma olmayotgan paytda qiling, yoki
 *  - hamma servis yangi kodda ishlay boshlagach, shu SQL ni
 *    (`HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL`, manba
 *    'hq_region_rule_deploy') psql bilan BIR MARTA qayta yurgizing:
 *    idempotent (`ON CONFLICT DO NOTHING`), manba bir xil — down() ularni
 *    ham o'chiradi. Kechiktirmang: keyingi yurish yangi kod bilan keyinroq
 *    HQ ga kelgan buyurtmalarni ham qamrab oladi.
 */
export const HQ_COURIER_COVERAGE_GRANDFATHER_SOURCE = 'hq_region_rule_deploy';

/**
 * up() SQL'i (yuqoridagi tanlov). Alohida eksport — deploy oynasidan keyin
 * psql bilan bir marta qayta yurgizish uchun aynan shu matn.
 */
export const HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL = `
      DO $$
      BEGIN
        IF to_regclass('"logistics_schema"."district_coverage_exemptions"') IS NULL
          OR to_regclass('"logistics_schema"."districts"') IS NULL
          OR to_regclass('"order_schema"."orders"') IS NULL
          OR to_regclass('"order_schema"."branch_transfer_batches"') IS NULL
          OR to_regclass('"branch_schema"."branches"') IS NULL THEN
          RETURN;
        END IF;
        INSERT INTO "logistics_schema"."district_coverage_exemptions"
          ("order_id", "branch_id", "district_id", "source")
        SELECT o."id", hq."id", o."district_id",
               '${HQ_COURIER_COVERAGE_GRANDFATHER_SOURCE}'
          FROM "order_schema"."orders" o
          -- Yo'ldagi (SENT) partiya — u borayotgan filial mas'ul.
          LEFT JOIN "order_schema"."branch_transfer_batches" b
            ON b."id" = o."current_batch_id"
           AND b."status"::text = 'SENT'
          JOIN "branch_schema"."branches" hq
            ON hq."id" = COALESCE(
                 NULLIF(b."destination_branch_id", 0),
                 CASE
                   WHEN upper(o."holder_type"::text) IN ('BRANCH', 'COURIER')
                   THEN NULLIF(o."holder_branch_id", 0)
                 END,
                 NULLIF(o."branch_id", 0)
               )
           AND upper(hq."type"::text) = 'HQ'
           AND hq."is_deleted" = false
          LEFT JOIN "logistics_schema"."districts" d
            ON d."id" = o."district_id"
         WHERE o."is_deleted" = false
           AND o."deleted_at" IS NULL
           AND o."status"::text IN ('on the road', 'waiting', 'waiting_customer', 'cancelled', 'sold')
           AND upper(COALESCE(o."holder_type"::text, '')) <> 'MARKET'
           AND (
             hq."region_id" IS NULL
             OR CASE
                  WHEN d."id" IS NOT NULL
                  THEN COALESCE(d."assigned_region", d."region_id")
                  ELSE o."region_id"
                END IS DISTINCT FROM hq."region_id"
           )
        ON CONFLICT ("order_id", "branch_id") DO NOTHING;
      END $$;
    `;

export class HqCourierCoverageGrandfather1716000000211 implements MigrationInterface {
  name = 'HqCourierCoverageGrandfather1716000000211';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"logistics_schema"."district_coverage_exemptions"') IS NULL THEN
          RETURN;
        END IF;
        DELETE FROM "logistics_schema"."district_coverage_exemptions"
         WHERE "source" = '${HQ_COURIER_COVERAGE_GRANDFATHER_SOURCE}';
      END $$;
    `);
  }
}
