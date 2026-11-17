import { MigrationInterface, QueryRunner } from 'typeorm';

/** identity `roleToCashboxType` bilan bir xil: rol → kassa turi. */
export const USER_CASHBOX_TYPE_BY_ROLE: Readonly<Record<string, string>> =
  Object.freeze({
    courier: 'couriers',
    market: 'markets',
  });
export const BRANCH_CASHBOX_TYPE = 'branch';

const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Foydalanuvchi kassalari (`finance_schema.cashboxes`) — yo'qolgan kuryer,
 * market va menejerli filial kassalarini tiklash (2026-11-17, baza tozalanishi
 * auditi: migratsiya 230 / 231 dagi holatning davomi).
 *
 * Belgisi: buyurtmani sotib bo'lmaydi — `POST /orders/sell/:id`,
 * `partly-sell`, `rollback`, qo'shimcha xarajat tasdig'i va xarajatli bekor
 * qilish 404 «Market kassasi topilmadi» / «Kuryer kassasi topilmadi» bilan
 * to'xtaydi (pul harakatidan OLDIN). Kuryerdan pul qabul qilish («Kuryer
 * kassasi topilmadi»), marketga to'lov va pickup tashrifi («Market kassasi
 * topilmadi»), admin kassa tafsiloti («Kassa topilmadi») ham ishlamaydi;
 * kargo sotuvining market oyog'i outbox'da tiqilib qoladi
 * (`finance.cashbox.update_balance` 404). Kassasi yo'q filialda HQ «Pul qabul
 * qilish», filial kartalari va menejer kirim/chiqimi 404 beradi.
 *
 * Sabab: bu qatorlarni hech bir migratsiya seed qilmaydi — ular foydalanuvchi
 * yaratilganda (identity `createCourier` / `createMarket` → FOR_COURIER /
 * FOR_MARKET, `createManager` / menejer biriktirish → BRANCH) bir marta
 * yaratiladi; menejerli filial kassalarining dastlabki to'plamini migratsiya
 * 008 yozgan (u «bajarilgan» — qayta yurmaydi). Baza tozalanganda kassalar
 * ketgan, foydalanuvchilar esa qolgan (yoki qayta tiklangan) bo'lsa, kuryer va
 * market kassasi O'ZI TIKLANMAYDI (faqat egasi «Kassa» sahifasini ochsa —
 * `my-cashbox`), ekranda yaratish yo'li yo'q (`POST /finance/cashbox` ni hech
 * bir sahifa chaqirmaydi).
 *
 * Qoida — har foydalanuvchi / filial uchun alohida, faqat shu turdagi kassa
 * UMUMAN bo'lmasa (seed belgisi: shu `(user_id, cashbox_type)` qatori,
 * o'chirilgani ham — kod kassani hech qachon o'chirmaydi, o'chirilgan qator
 * faqat qo'lda bo'ladi va tiriltirilmaydi):
 *   - o'chirilmagan `role = 'courier'` foydalanuvchi — `couriers` kassasi;
 *   - o'chirilmagan `role = 'market'` foydalanuvchi — `markets` kassasi
 *     (nofaol foydalanuvchilar ham: ularning eski buyurtmalari sotiladi /
 *     bekor qilinadi; boshqa rollar — identity `roleToCashboxType` bo'yicha
 *     kassasiz);
 *   - o'chirilmagan, HQ bo'lmagan va o'chirilmagan MANAGER a'zosi bor filial
 *     — `branch` kassasi (`user_id = branch_id`; 008 ning birinchi INSERT'i
 *     aynan). HQ kassasi yo'q (HQ — MAIN); menejersiz filialga kassa birinchi
 *     sotuvda o'zi yaratiladi.
 * Balans har doim 0: kassa tarixi (`cashbox_history`, ON DELETE CASCADE)
 * kassa bilan birga ketgan — 0 = tarix yig'indisi, `db:check-cashbox`
 * invarianti buzilmaydi. Haqiqiy qarz/naqd pul qo'lda solishtiriladi; tarix
 * qatorlari yozilmaydi. MAIN kassaga tegilmaydi — uni finance-service har
 * ishga tushishda o'zi yaratadi.
 *
 * Poyga: `(user_id, cashbox_type)` da UNIQUE indeks yo'q, `my-cashbox` /
 * `ensureBranchCashbox` esa «topilmasa — yaratish» qiladi. Jadval
 * tranzaksiya oxirigacha `SHARE ROW EXCLUSIVE` bilan qulflanadi (o'qish
 * ishlayveradi, parallel yozuv kutadi): qulfdan OLDIN boshlangan yaratish
 * avval commit bo'ladi va migratsiya uni ko'rib, ikkinchisini yozmaydi.
 * Qulf to'liq kafolat EMAS: migratsiya INSERT'idan commit'gacha bo'lgan
 * millisekundlarda «topilmadi» deb o'qigan so'rov commit'dan keyin baribir
 * ikkinchi qator yozishi mumkin (ikki parallel so'rovda kodning o'zi ham
 * shunday). Deploy'dan keyin tekshiruv (bo'sh bo'lishi kerak):
 *   SELECT user_id, cashbox_type, count(*) FROM finance_schema.cashboxes
 *    WHERE NOT is_deleted GROUP BY 1, 2 HAVING count(*) > 1;
 * `ACCESS EXCLUSIVE` ataylab olinmaydi: u pg_dump yoki uzun o'qish tugashini
 * kutadi va shu vaqt ichida kassani o'qishni ham to'xtatib qo'yardi.
 *
 * Qayta yurgizish xavfsiz: ikkinchi marta har kassa allaqachon bor.
 * Jadval(lar) yo'q muhitda — mos qadam o'tkazib yuboriladi.
 *
 * down(): hech narsa qilmaydi — tiklangan kassalarda yangi pul harakati
 * bo'lishi mumkin; sxema o'zgarmagan.
 */

export class RestoreUserCashboxes1716000000234 implements MigrationInterface {
  name = 'RestoreUserCashboxes1716000000234';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [tables] = (await queryRunner.query(
      `SELECT to_regclass('finance_schema.cashboxes') IS NOT NULL AS cashboxes,
              to_regclass('identity_schema.admins') IS NOT NULL AS users,
              to_regclass('branch_schema.branches') IS NOT NULL
                AND to_regclass('branch_schema.branch_users') IS NOT NULL AS branches`,
    )) as Array<{ cashboxes: boolean; users: boolean; branches: boolean }>;
    if (!tables.cashboxes || (!tables.users && !tables.branches)) {
      return;
    }

    const steps: string[] = [];
    if (tables.users) {
      for (const [role, cashboxType] of Object.entries(
        USER_CASHBOX_TYPE_BY_ROLE,
      )) {
        steps.push(`
        INSERT INTO "finance_schema"."cashboxes"
          ("balance", "balance_cash", "balance_card", "cashbox_type", "user_id", "is_deleted")
        SELECT 0, 0, 0, ${sqlLiteral(cashboxType)}, u."id", false
          FROM "identity_schema"."admins" u
         WHERE u."role"::text = ${sqlLiteral(role)}
           AND u."is_deleted" = false
           AND NOT EXISTS (
             SELECT 1 FROM "finance_schema"."cashboxes" c
              WHERE c."user_id" = u."id"
                AND c."cashbox_type"::text = ${sqlLiteral(cashboxType)}
           );
        GET DIAGNOSTICS restored = ROW_COUNT;
        RAISE NOTICE 'RestoreUserCashboxes: % ta % kassasi tiklandi', restored, ${sqlLiteral(cashboxType)};`);
      }
    }
    if (tables.branches) {
      steps.push(`
        INSERT INTO "finance_schema"."cashboxes"
          ("balance", "balance_cash", "balance_card", "cashbox_type", "user_id", "is_deleted")
        SELECT 0, 0, 0, ${sqlLiteral(BRANCH_CASHBOX_TYPE)}, m."branch_id", false
          FROM (
            SELECT DISTINCT bu."branch_id"
              FROM "branch_schema"."branch_users" bu
              JOIN "branch_schema"."branches" b
                ON b."id" = bu."branch_id"
               AND b."is_deleted" = false
               AND b."type"::text <> 'HQ'
             WHERE bu."role"::text = 'MANAGER'
               AND bu."is_deleted" = false
          ) m
         WHERE NOT EXISTS (
           SELECT 1 FROM "finance_schema"."cashboxes" c
            WHERE c."user_id" = m."branch_id"
              AND c."cashbox_type"::text = ${sqlLiteral(BRANCH_CASHBOX_TYPE)}
         );
        GET DIAGNOSTICS restored = ROW_COUNT;
        RAISE NOTICE 'RestoreUserCashboxes: % ta % kassasi tiklandi', restored, ${sqlLiteral(BRANCH_CASHBOX_TYPE)};`);
    }

    // Bitta DO blok: qulf va yozuvlar bitta tranzaksiyada (migratsiya
    // tranzaksiyasiz yurgizilsa ham — blok o'zi tranzaksiya ichida).
    await queryRunner.query(`
      DO $$
      DECLARE
        restored integer;
      BEGIN
        LOCK TABLE "finance_schema"."cashboxes" IN SHARE ROW EXCLUSIVE MODE;
        ${steps.join('\n')}
      END
      $$;
    `);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh — yuqoridagi izohga qarang.
  }
}
