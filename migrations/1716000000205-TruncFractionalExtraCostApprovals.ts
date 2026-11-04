import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * iMNLvs06: kasrli qo'shimcha xarajat so'rovlari.
 *
 * Gateway ilgari `extraCost` ga faqat `@IsNumber` qo'yardi, shuning uchun API
 * orqali 1500.5 kabi kasr o'tib, `order_extra_cost_approvals.amount`
 * (numeric(14,2)) va `operation_payload.extraCost` ga yozilardi. Tasdiqda
 * sotuv qayta bajarilib `orders.extra_cost` (int) ga kasr yozilmay,
 * tranzaksiya qaytardi — so'rov abadiy «kutilmoqda» qolardi. Endi gateway va
 * order-service kasr qismini tashlaydi (1500.5 → 1500); bu migratsiya allaqachon
 * yozilgan KUTILAYOTGAN so'rovlarni ham shunday qiladi, market ularni
 * tasdiqlay oladi.
 *
 * XAVFSIZLIK: faqat `pending`, o'chirilmagan va summasi kasr bo'lgan qatorlar;
 * yakunlangan so'rovlarga tegilmaydi. Qayta yurgizish hech narsani
 * o'zgartirmaydi. Jadval bo'lmasa — hech narsa qilinmaydi.
 * down(): asl kasr qismi saqlanmaydi, shuning uchun hech narsa qilmaydi.
 */
export class TruncFractionalExtraCostApprovals1716000000205 implements MigrationInterface {
  name = 'TruncFractionalExtraCostApprovals1716000000205';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"order_schema"."order_extra_cost_approvals"') IS NULL THEN
          RETURN;
        END IF;
        UPDATE "order_schema"."order_extra_cost_approvals"
           SET "amount" = trunc("amount"),
               "operation_payload" = CASE
                 WHEN jsonb_typeof("operation_payload" -> 'extraCost') = 'number'
                   THEN jsonb_set(
                     "operation_payload",
                     '{extraCost}',
                     to_jsonb(trunc(("operation_payload" ->> 'extraCost')::numeric))
                   )
                 ELSE "operation_payload"
               END,
               "updatedAt" = now()
         WHERE "status" = 'pending'
           AND "is_deleted" = false
           AND "amount" <> trunc("amount");
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Asl kasr qismi saqlanmaydi — qaytarib bo'lmaydi.
  }
}
