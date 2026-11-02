import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pochta ↔ buyurtma TARIXI (ega qarori, 2026-11-02): eski pochta ichiga
 * QACHONDIR kirgan HAR buyurtmani ko'rsatadi.
 *
 * Muammo: buyurtmada bitta `post_id` / `canceled_post_id` ko'rsatkichi bor va
 * u buyurtma yurgan sari USTIGA yoziladi (filial pochtasi → kuryer SENT
 * pochtasi, qaytarishni tasdiqlash `post_id = null`, bekor pochtani qabul
 * qilish `canceled_post_id = null`). Natijada logistika eski pochta ro'yxatini
 * joriy ko'rsatkichlardan quradi va u bo'sh chiqadi. Tarix jadvali yo'q edi.
 *
 * `order_schema.post_order_memberships` — har "pochtada turish" bitta qator:
 *   • `kind` — DELIVERY (`post_id`) yoki CANCELED (`canceled_post_id`);
 *   • `joined_at` / `left_at` — kirgan / chiqqan vaqt (`left_at` NULL — hozir
 *     shu pochtada);
 *   • `next_post_id` — chiqqanda qaysi pochtaga o'tgani (NULL — pochtasiz);
 *   • `source` — 'trigger' (jonli), 'seed_current' (shu migratsiya),
 *     'backfill_<manba>' (scripts/backfill-post-order-memberships.ts).
 *
 * `post_id` ga FK YO'Q ataylab: pochtalar boshqa sxemada (`logistics_schema`)
 * va QATTIQ o'chiriladi — tarix qatori qolishi kerak. `order_id` — FK
 * (buyurtma qattiq o'chsa tarixi ham ketadi).
 *
 * Trigger `track_post_membership` (AFTER INSERT / UPDATE OF post_id,
 * canceled_post_id): ko'rsatkich O'ZGARGANDA ochiq qator yopiladi
 * (`left_at` = o'zgarish vaqti, `next_post_id` = yangi qiymat) va yangi qiymat
 * NULL bo'lmasa yangi ochiq qator yoziladi. Buyurtma tranzaksiyasi ICHIDA
 * ishlaydi — tarix va ko'rsatkich doim birga commit bo'ladi. `ON CONFLICT DO
 * NOTHING` — tarix yozuvi buyurtma amalini hech qachon yiqitmasin (ochiq
 * qator yuqorida yopilgani uchun to'qnashuv amalda bo'lmaydi).
 *
 * O'zgarish vaqti — `clock_timestamp()` (har chaqiruvda BIR marta olinadi:
 * yopilgan qatorning `left_at` i = yangisining `joined_at` i). `now()` emas:
 * u tranzaksiya BOSHI vaqti — erta boshlangan, lekin keyinroq ko'rsatkichni
 * o'zgartirgan tranzaksiya `left_at < joined_at` va noto'g'ri `ORDER BY
 * joined_at` tartibini yozardi (deploy paytida ochiq turgan tranzaksiya esa
 * seed vaqtidan oldingi `joined_at` ni). Buyurtma qatori qulfi bir
 * buyurtmaning UPDATE'larini ketma-ket qiladi — vaqtlar o'sib boradi.
 * Jadval DEFAULT'i va seed — `now()` (migratsiya vaqti, backfill chegarasi).
 *
 * Seed: ko'rsatkichi bor HAR buyurtma (o'chirilganlari ham — trigger ham
 * ularni kuzatadi) uchun bitta ochiq qator, `joined_at = now()` (haqiqiy
 * kirgan vaqt noma'lum — backfill skripti tarixdan to'g'rilaydi).
 *
 * TARTIB va QULF: trigger seed'dan OLDIN yaratiladi — `CREATE TRIGGER`
 * `orders` ga SHARE ROW EXCLUSIVE qulf oladi va u commit'gacha turadi: seed
 * bilan trigger orasida parallel o'zgarish tushib qolmaydi. `order_id` FK
 * va indekslar seed'dan KEYIN qo'shiladi: FK oldin bo'lsa har seed qatori RI
 * tekshiruvi bilan `orders` qatoriga FOR KEY SHARE qo'yadi (har sahifa
 * iflos + WAL, `orders` yozuvlari qulfda turgan vaqt ~2 barobar); keyin
 * qo'shilgan FK bitta anti-join bilan tekshiriladi, qator qulfisiz. Ommaviy
 * indeks qurish ham tezroq (birinchi yurgizishda jadval bo'sh, seed bir
 * buyurtmaga bitta qator yozadi). Production barcha kutilgan migratsiyalarni
 * BITTA tranzaksiyada yurgizadi (scripts/db-prepare.ts) — `CONCURRENTLY` yo'q.
 *
 * XAVFSIZLIK: pulga tegmaydi. `IF NOT EXISTS` / `CREATE OR REPLACE` /
 * `ON CONFLICT DO NOTHING` / FK uchun `pg_constraint` tekshiruvi — qayta
 * yurgizish xatosiz va dublikatsiz.
 * down(): trigger, funksiya va jadval o'chiriladi.
 */
export const POST_ORDER_MEMBERSHIP_TABLE =
  '"order_schema"."post_order_memberships"';
export const POST_ORDER_MEMBERSHIP_FUNCTION =
  '"order_schema"."track_post_membership"';
export const POST_ORDER_MEMBERSHIP_TRIGGER = 'TRG_ORDERS_TRACK_POST_MEMBERSHIP';
export const POST_ORDER_MEMBERSHIP_ORDER_FK = 'FK_POST_ORDER_MEMBERSHIP_ORDER';

/** Ko'rsatkich ustuni → tarix turi (trigger va seed uchun yagona ro'yxat). */
export const POST_ORDER_MEMBERSHIP_KINDS = [
  { column: 'post_id', kind: 'DELIVERY' },
  { column: 'canceled_post_id', kind: 'CANCELED' },
] as const;

export class PostOrderMemberships1716000000201 implements MigrationInterface {
  name = 'PostOrderMemberships1716000000201';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${POST_ORDER_MEMBERSHIP_TABLE} (
        "id" bigserial PRIMARY KEY,
        "order_id" bigint NOT NULL,
        "post_id" bigint NOT NULL,
        "kind" varchar(16) NOT NULL,
        "joined_at" timestamptz NOT NULL DEFAULT now(),
        "left_at" timestamptz NULL,
        "next_post_id" bigint NULL,
        "source" varchar(32) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_POST_ORDER_MEMBERSHIP_KIND"
          CHECK ("kind" IN ('DELIVERY', 'CANCELED'))
      )
    `);

    // Har tur uchun AYNI blok: ko'rsatkich o'zgardi → ochiq qator yopiladi,
    // yangi qiymat bo'lsa yangi ochiq qator. INSERT da OLD yo'q — eski qiymat
    // NULL deb olinadi (OLD maydoniga INSERT da murojaat qilinmaydi).
    const blocks = POST_ORDER_MEMBERSHIP_KINDS.map(
      ({ column, kind }) => `
        IF TG_OP = 'UPDATE' THEN
          old_value := OLD."${column}";
        ELSE
          old_value := NULL;
        END IF;
        IF NEW."${column}" IS DISTINCT FROM old_value THEN
          UPDATE ${POST_ORDER_MEMBERSHIP_TABLE}
             SET "left_at" = changed_at, "next_post_id" = NEW."${column}"
           WHERE "order_id" = NEW."id" AND "kind" = '${kind}'
             AND "left_at" IS NULL;
          IF NEW."${column}" IS NOT NULL THEN
            INSERT INTO ${POST_ORDER_MEMBERSHIP_TABLE}
              ("order_id", "post_id", "kind", "joined_at", "source")
            VALUES (NEW."id", NEW."${column}", '${kind}', changed_at, 'trigger')
            ON CONFLICT DO NOTHING;
          END IF;
        END IF;`,
    ).join('\n');

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${POST_ORDER_MEMBERSHIP_FUNCTION}()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        old_value bigint;
        changed_at timestamptz := clock_timestamp();
      BEGIN
        ${blocks}
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "${POST_ORDER_MEMBERSHIP_TRIGGER}"
        ON "order_schema"."orders"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "${POST_ORDER_MEMBERSHIP_TRIGGER}"
      AFTER INSERT OR UPDATE OF "post_id", "canceled_post_id"
        ON "order_schema"."orders"
      FOR EACH ROW EXECUTE FUNCTION ${POST_ORDER_MEMBERSHIP_FUNCTION}()
    `);

    // Seed — hozirgi ko'rsatkichlar (qayta yurgizishda ochiq qator bor —
    // qisman unikal indeks tufayli hech narsa qo'shilmaydi).
    for (const { column, kind } of POST_ORDER_MEMBERSHIP_KINDS) {
      await queryRunner.query(`
        INSERT INTO ${POST_ORDER_MEMBERSHIP_TABLE}
          ("order_id", "post_id", "kind", "joined_at", "source")
        SELECT o."id", o."${column}", '${kind}', now(), 'seed_current'
          FROM "order_schema"."orders" o
         WHERE o."${column}" IS NOT NULL
        ON CONFLICT DO NOTHING
      `);
    }

    // FK seed'dan KEYIN (yuqoridagi izoh): bitta anti-join, qator qulfisiz.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = '${POST_ORDER_MEMBERSHIP_ORDER_FK}'
             AND conrelid = '${POST_ORDER_MEMBERSHIP_TABLE}'::regclass
        ) THEN
          ALTER TABLE ${POST_ORDER_MEMBERSHIP_TABLE}
            ADD CONSTRAINT "${POST_ORDER_MEMBERSHIP_ORDER_FK}"
            FOREIGN KEY ("order_id") REFERENCES "order_schema"."orders" ("id")
            ON DELETE CASCADE;
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_POST_ORDER_MEMBERSHIP_POST"
        ON ${POST_ORDER_MEMBERSHIP_TABLE} ("post_id", "kind", "joined_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_POST_ORDER_MEMBERSHIP_ORDER"
        ON ${POST_ORDER_MEMBERSHIP_TABLE} ("order_id", "joined_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_POST_ORDER_MEMBERSHIP_OPEN"
        ON ${POST_ORDER_MEMBERSHIP_TABLE} ("order_id", "kind")
        WHERE "left_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "${POST_ORDER_MEMBERSHIP_TRIGGER}"
        ON "order_schema"."orders"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS ${POST_ORDER_MEMBERSHIP_FUNCTION}()
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS ${POST_ORDER_MEMBERSHIP_TABLE}
    `);
  }
}
