import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bitta operator — bir nechta market, 3-bosqich (ega qarorlari 2026-11-28,
 * D3 — har market o'z operator ulushini alohida to'laydi).
 *
 * Market «Operatorlar → To'lovlar» sahifasidagi qoldiq, daromadlar va to'lovlar
 * endi faqat `market_id = shu market` bo'yicha yig'iladi (ilgari faqat
 * `operator_id` bo'yicha — bir nechta marketli operatorda market A B ning
 * pulini ko'rardi). Buning uchun eski `market_id IS NULL` qatorlar marketga
 * biriktiriladi — aks holda ular market sahifasidan yo'qolardi:
 *
 *  1. `finance_schema.operator_earnings.market_id` NULL → buyurtmaning
 *     `order_schema.orders.market_id` (daromad aynan shu buyurtma uchun —
 *     aniq).
 *  2. `finance_schema.operator_payments.market_id` NULL (eski `source =
 *     'elchi'` to'lovlari, Asosiy kassadan) → operatorning `identity_schema.
 *     admins.market_id` si. Hozir HAR operator bitta marketda ishlaydi —
 *     biriktirish bir ma'noli (ikkinchi marketga ulash hali yopiq).
 *
 * Faqat NULL qatorlar, faqat `market_id` ustuni — summa, holat, bekor
 * qilish, kassa va P&L ga tegilmaydi. Biriktirib bo'lmaydiganlar (buyurtma
 * qattiq o'chgan / operatorda market yo'q) NULL qoladi va NOTICE da
 * sanaladi; ular operatorning o'z «Daromadim» jamisida ko'rinadi
 * (`by_market` da `market_id: null`), market sahifasida — yo'q.
 *
 * Qayta yurgizish xavfsiz (faqat `IS NULL`). Jadval/sxema yo'q muhitda
 * o'tkazib yuboriladi.
 *
 * down(): no-op — qaysi qator NULL bo'lganini saqlamaymiz va to'ldirilgan
 * `market_id` to'g'ri qiymat (orqaga qaytarish market sahifasini avvalgi
 * «hamma marketlar» holatiga qaytarmaydi, kod endi NULL ni ko'rsatmaydi).
 */
export const BACKFILL_OPERATOR_FINANCE_MARKET_SQL = `
  DO $$
  DECLARE
    earnings_filled integer := 0;
    payments_filled integer := 0;
    earnings_left integer := 0;
    payments_left integer := 0;
  BEGIN
    IF to_regclass('"finance_schema"."operator_earnings"') IS NOT NULL
       AND to_regclass('"order_schema"."orders"') IS NOT NULL THEN
      UPDATE "finance_schema"."operator_earnings" e
         SET "market_id" = o."market_id"
        FROM "order_schema"."orders" o
       WHERE e."market_id" IS NULL
         AND o."id" = e."order_id"
         AND o."market_id" IS NOT NULL;
      GET DIAGNOSTICS earnings_filled = ROW_COUNT;
      SELECT count(*)::integer INTO earnings_left
        FROM "finance_schema"."operator_earnings"
       WHERE "market_id" IS NULL;
    END IF;

    IF to_regclass('"finance_schema"."operator_payments"') IS NOT NULL
       AND to_regclass('"identity_schema"."admins"') IS NOT NULL THEN
      UPDATE "finance_schema"."operator_payments" p
         SET "market_id" = a."market_id"
        FROM "identity_schema"."admins" a
       WHERE p."market_id" IS NULL
         AND a."id" = p."operator_id"
         AND a."market_id" IS NOT NULL;
      GET DIAGNOSTICS payments_filled = ROW_COUNT;
      SELECT count(*)::integer INTO payments_left
        FROM "finance_schema"."operator_payments"
       WHERE "market_id" IS NULL;
    END IF;

    RAISE NOTICE 'OperatorFinanceMarketBackfill: earnings % ta biriktirildi (% ta NULL qoldi), payments % ta biriktirildi (% ta NULL qoldi)',
      earnings_filled, earnings_left, payments_filled, payments_left;
  END
  $$
`;

export class OperatorFinanceMarketBackfill1716000000257 implements MigrationInterface {
  name = 'OperatorFinanceMarketBackfill1716000000257';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(BACKFILL_OPERATOR_FINANCE_MARKET_SQL);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh — yuqoridagi izohga qarang.
  }
}
