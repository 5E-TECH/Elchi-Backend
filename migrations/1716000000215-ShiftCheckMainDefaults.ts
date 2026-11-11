import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-A (ega qarori 2026-11-10) — smena yopishda karta qoldig'i skrinshoti
 * ASOSIY (MAIN) kassada sukut bo'yicha MAJBURIY: «majburiy, superadmin
 * kartama-karta o'chira oladi», «filiallarga default o'chiq, faqat asosiy
 * kassaga», «darhol yoqilsin»; AI tekshiruvi ham («Ha, yoqilsin»).
 *
 * up():
 *   1. `finance_schema.finance_settings` — `shift.account_check.enabled`,
 *      `shift.photo.required`, `shift.ai_check.enabled` = `true`. Mavjud
 *      qiymat (superadmin avval o'chirgan bo'lsa ham) USTIGA YOZILADI
 *      («darhol yoqilsin»); o'chirilgan (`is_deleted`) qator tiklanadi,
 *      `updated_by` = NULL (tizim).
 *   2. `shift.account_check.branch_enabled` (filial kassalari kaliti) =
 *      `false` — faqat qator YO'Q bo'lsa (superadmin qo'ygani saqlanadi).
 *   3. `finance_schema.cashbox_cards` — MAIN kassaning (`cashbox_type =
 *      'main'`, o'chirilmagan) HAR o'chirilmagan kartasida (arxivlangan —
 *      `is_active = false` ham) `require_photo_on_shift_close = true`,
 *      `ai_check_enabled = true`. Filial / kuryer / market kartalariga
 *      TEGILMAYDI. Ikkala ustun bitta UPDATE'da — CHECK
 *      `CHK_CASHBOX_CARD_AI_NEEDS_PHOTO` (161) buzilmaydi.
 *
 * ⚠️ Deploy paytida OCHIQ turgan MAIN smenasi ham yopishda har faol karta
 * qoldig'i + rasmini talab qiladi (sozlama yopish paytida o'qiladi).
 *
 * XAVFSIZLIK: pulga tegmaydi (balanslar, tarix o'zgarmaydi). Bitta `DO`
 * bloki — prod barcha kutilayotgan migratsiyalarni bitta tranzaksiyada
 * yurgizadi, bu yerda tranzaksiyadan tashqari buyruq yo'q. Jadval bo'lmasa
 * (`to_regclass`) — o'tkazib yuboriladi. Qayta yurgizish xatosiz va natija
 * bir xil (ikkinchi marta hech narsa o'zgarmaydi).
 *
 * down(): avvalgi kod sukutlari tiklanadi — `shift.account_check.enabled` =
 * `false`, `shift.ai_check.enabled` = `false` (`shift.photo.required` avval
 * ham `true` edi — qoladi), filial kaliti qatori o'chiriladi. Karta
 * bayroqlari QAYTARILMAYDI: qaysi kartani shu migratsiya yoqqani, qaysini
 * superadmin avval yoqqani saqlanmaydi (farqlab bo'lmaydi). Tasdiqlash va AI
 * master kalitlari o'chiq bo'lgach bu bayroqlar faqat kassir `accounts[]`
 * ni o'zi yuborganda rasm talab qiladi; kerak bo'lsa superadmin kartama-karta
 * o'chiradi (`PATCH /finance/shift/settings`). down() ham qayta yurgizishda
 * xatosiz.
 */
export const SHIFT_CHECK_MAIN_ON_KEYS = [
  'shift.account_check.enabled',
  'shift.photo.required',
  'shift.ai_check.enabled',
] as const;
export const SHIFT_CHECK_BRANCH_KEY = 'shift.account_check.branch_enabled';

const SETTINGS = '"finance_schema"."finance_settings"';
const CARDS = '"finance_schema"."cashbox_cards"';
const CASHBOXES = '"finance_schema"."cashboxes"';

const sqlList = (keys: readonly string[]) =>
  keys.map((key) => `('${key}', 'true'::jsonb)`).join(', ');

export class ShiftCheckMainDefaults1716000000215 implements MigrationInterface {
  name = 'ShiftCheckMainDefaults1716000000215';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('${SETTINGS}') IS NOT NULL THEN
          INSERT INTO ${SETTINGS} ("key", "value")
          VALUES ${sqlList(SHIFT_CHECK_MAIN_ON_KEYS)}
          ON CONFLICT ("key") DO UPDATE
             SET "value" = EXCLUDED."value",
                 "is_deleted" = false,
                 "updated_by" = NULL,
                 "updatedAt" = now()
           WHERE ${SETTINGS}."value" IS DISTINCT FROM EXCLUDED."value"
              OR ${SETTINGS}."is_deleted" = true;
          INSERT INTO ${SETTINGS} ("key", "value")
          VALUES ('${SHIFT_CHECK_BRANCH_KEY}', 'false'::jsonb)
          ON CONFLICT ("key") DO NOTHING;
        END IF;
        IF to_regclass('${CARDS}') IS NOT NULL
          AND to_regclass('${CASHBOXES}') IS NOT NULL THEN
          UPDATE ${CARDS} c
             SET "require_photo_on_shift_close" = true,
                 "ai_check_enabled" = true,
                 "updatedAt" = now()
            FROM ${CASHBOXES} cb
           WHERE cb."id" = c."cashbox_id"
             AND cb."cashbox_type"::text = 'main'
             AND cb."is_deleted" = false
             AND c."is_deleted" = false
             AND (c."require_photo_on_shift_close" = false
                  OR c."ai_check_enabled" = false);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('${SETTINGS}') IS NOT NULL THEN
          INSERT INTO ${SETTINGS} ("key", "value")
          VALUES ('shift.account_check.enabled', 'false'::jsonb),
                 ('shift.ai_check.enabled', 'false'::jsonb)
          ON CONFLICT ("key") DO UPDATE
             SET "value" = EXCLUDED."value",
                 "is_deleted" = false,
                 "updated_by" = NULL,
                 "updatedAt" = now()
           WHERE ${SETTINGS}."value" IS DISTINCT FROM EXCLUDED."value"
              OR ${SETTINGS}."is_deleted" = true;
          DELETE FROM ${SETTINGS} WHERE "key" = '${SHIFT_CHECK_BRANCH_KEY}';
        END IF;
      END $$;
    `);
  }
}
