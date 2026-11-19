import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 63HO6cBU (P0, ega qarori 2026-11-17) — FILIAL (BRANCH) kassasi naqd va
 * kartaga AJRALMAYDI: bitta jami chelak (`balance_cash`), `balance_card` = 0
 * (FOR_COURIER / FOR_MARKET dagi 1bz6tOle bilan bir xil). Kod tomoni —
 * finance `updateBalancesByMethod`.
 *
 * up():
 *  1) har BRANCH kassasi: `balance_cash += balance_card`, `balance_card = 0`;
 *     `balance` (jami) O'ZGARMAYDI;
 *  2) filial kassasi kartalari (nomli va Asosiy) nofaol bo'ladi, nomli karta
 *     qoldig'i 0 (u `balance_card` ning bir qismi edi — u ham jamiga o'tdi).
 *     Kartalar O'CHIRILMAYDI — tarix (`cashbox_history.card_id`, harakatlar,
 *     smena tekshiruvlari) saqlanadi;
 *  3) OCHIQ filial smenasi: ochilishdagi karta surati jamiga qo'shiladi
 *     (`opening_balance_cash += opening_balance_card`, karta = 0) — aks holda
 *     yopishda soxta tafovut chiqardi.
 *
 * 0) (N1) Har filial kartasining qoldig'i jamiga o'tgani JURNALGA yoziladi:
 *    bitta `cashbox_card_movements` qatori (nomli — `card.balance`, Asosiy —
 *    `balance_card − Σ nomli`), izoh «Migratsiya 245: karta qoldig'i
 *    jamiga», `dedup_epoch` = `migration-245:card:<id>:<txid>` (har yurish
 *    noyob; qayta yurganda qoldiq 0 — qator yozilmaydi; up → down → up da
 *    yangi qator). Vaqt — `clock_timestamp()` (tranzaksiya boshi emas). Musbat — `card_to_cash`, manfiy —
 *    `cash_to_card`. Shu bilan eski karta ko'chirmasi (`getLedger`, joriy
 *    qoldiqdan orqaga hisoblanadi) to'g'ri ochilish/yopilish ko'rsatadi.
 *    `cashbox_cards.deactivated_at` (yangi, nullable) — nofaol qilingan vaqt:
 *    ko'chirma filial kartasi uchun undan keyingi qatorlarni olmaydi.
 *
 * Idempotent: ikkinchi yurgizishda o'zgaradigan qator yo'q (karta qismlari
 * allaqachon 0, kartalar nofaol) — natija bir xil. Asl qiymatlar zaxira
 * jadvallariga (`*_backup_245`, ON CONFLICT DO NOTHING — birinchi surat
 * saqlanadi) yoziladi; down() ulardan tiklaydi.
 *
 * Relizda: 240–245 bitta tranzaksiyada (scripts/db-prepare.ts), kam
 * yuklamali vaqtda. 241/243/244 indekslari CONCURRENTLY'siz: eski
 * finance-service ishlab turgan paytda filial pul tranzaksiyasi bilan
 * deadlock bo'lishi mumkin — shunda deploy'ni (db-prepare) qayta yurgizing,
 * hammasi bitta tranzaksiya, yarim holat qolmaydi.
 * ORQAGA QAYTARISH (F4): kod revert'idan keyin down() (faqat jami o'zgarmagan
 * kassalarda bo'linish tiklanadi); so'ng ochiq filial smenalarini yopib-qayta
 * oching, arxiv filial karta ko'chirmalariga qaramang (eski kod yangi kodning
 * filial `click` qatorlarini karta harakati deb o'qiydi).
 * `lock_timeout` 5 s (241/243/244 kabi): ochiq pul yozuvi
 * tranzaksiyasi bo'lsa UPDATE uzoq kutmaydi — migratsiya yiqiladi, qayta
 * yurgiziladi. Faqat BRANCH qatorlari (filiallar soni — o'nlab) qulflanadi.
 */
export class BranchCashboxSingleBucket1716000000245 implements MigrationInterface {
  name = 'BranchCashboxSingleBucket1716000000245';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."branch_cashbox_backup_245" (
        "cashbox_id" bigint PRIMARY KEY,
        "balance_cash" numeric(20,2) NOT NULL,
        "balance_card" numeric(20,2) NOT NULL,
        "saved_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."branch_card_backup_245" (
        "card_id" bigint PRIMARY KEY,
        "balance" numeric(20,2) NOT NULL,
        "is_active" boolean NOT NULL,
        "saved_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."branch_shift_backup_245" (
        "shift_id" bigint PRIMARY KEY,
        "opening_balance_cash" numeric(20,2) NOT NULL,
        "opening_balance_card" numeric(20,2) NOT NULL,
        "saved_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // 0) N1 — karta qoldiqlarining jamiga o'tishi jurnalga (kassa va
    // kartalar O'ZGARISHIDAN OLDIN — Asosiy karta qismi `balance_card` dan).
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_cards"
        ADD COLUMN IF NOT EXISTS "deactivated_at" timestamptz NULL
    `);
    await queryRunner.query(`
      WITH parts AS (
        SELECT c."id" AS card_id, c."cashbox_id",
               CASE WHEN c."is_default"
                    THEN cb."balance_card" - COALESCE((
                           SELECT SUM(n."balance")
                             FROM "finance_schema"."cashbox_cards" n
                            WHERE n."cashbox_id" = c."cashbox_id"
                              AND n."is_default" = false
                              AND n."is_deleted" = false), 0)
                    ELSE c."balance" END AS amount
          FROM "finance_schema"."cashbox_cards" c
          JOIN "finance_schema"."cashboxes" cb ON cb."id" = c."cashbox_id"
         WHERE cb."cashbox_type" = 'branch' AND c."is_deleted" = false
      )
      INSERT INTO "finance_schema"."cashbox_card_movements"
        ("createdAt", "updatedAt",
         "type", "cashbox_id", "from_card_id", "to_card_id", "amount",
         "balance_after_from", "balance_after_to", "comment", "created_by",
         "dedup_epoch")
      SELECT clock_timestamp(), clock_timestamp(),
             CASE WHEN p.amount > 0 THEN 'card_to_cash' ELSE 'cash_to_card' END,
             p."cashbox_id",
             CASE WHEN p.amount > 0 THEN p.card_id END,
             CASE WHEN p.amount < 0 THEN p.card_id END,
             ABS(p.amount),
             CASE WHEN p.amount > 0 THEN 0 END,
             CASE WHEN p.amount < 0 THEN 0 END,
             'Migratsiya 245: karta qoldig''i jamiga',
             NULL,
             'migration-245:card:' || p.card_id || ':' || txid_current()
        FROM parts p
       WHERE p.amount <> 0
    `);
    // Y-1/Y-2: shu yurishda harakat olgan har karta — kesim harakatdan KEYIN
    // (clock_timestamp: db-prepare 240–245 ni bitta tranzaksiyada yuradi,
    // now() esa tranzaksiya boshi — oynadagi eski servis to'lovi kesimdan
    // chiqib qolardi). Avvalgi (up → down → up) qiymat ustidan yoziladi.
    await queryRunner.query(`
      UPDATE "finance_schema"."cashbox_cards" c
         SET "deactivated_at" = clock_timestamp()
        FROM "finance_schema"."cashbox_card_movements" m
       WHERE m."dedup_epoch" =
             'migration-245:card:' || c."id" || ':' || txid_current()
    `);

    // 1) Kassa: zaxira (faqat karta qismi bor qatorlar) → bitta jami.
    await queryRunner.query(`
      INSERT INTO "finance_schema"."branch_cashbox_backup_245"
        ("cashbox_id", "balance_cash", "balance_card")
      SELECT cb."id", cb."balance_cash", cb."balance_card"
        FROM "finance_schema"."cashboxes" cb
       WHERE cb."cashbox_type" = 'branch' AND cb."balance_card" <> 0
      ON CONFLICT ("cashbox_id") DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE "finance_schema"."cashboxes"
         SET "balance_cash" = "balance_cash" + "balance_card",
             "balance_card" = 0
       WHERE "cashbox_type" = 'branch' AND "balance_card" <> 0
    `);

    // 2) Filial kartalari: nofaol, nomli karta qoldig'i 0 (tarix qoladi).
    await queryRunner.query(`
      INSERT INTO "finance_schema"."branch_card_backup_245"
        ("card_id", "balance", "is_active")
      SELECT c."id", c."balance", c."is_active"
        FROM "finance_schema"."cashbox_cards" c
        JOIN "finance_schema"."cashboxes" cb ON cb."id" = c."cashbox_id"
       WHERE cb."cashbox_type" = 'branch'
         AND (c."is_active" = true OR c."balance" <> 0)
      ON CONFLICT ("card_id") DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE "finance_schema"."cashbox_cards" c
         SET "is_active" = false,
             "balance" = 0,
             "deactivated_at" = COALESCE(c."deactivated_at", clock_timestamp())
        FROM "finance_schema"."cashboxes" cb
       WHERE cb."id" = c."cashbox_id"
         AND cb."cashbox_type" = 'branch'
         AND (c."is_active" = true OR c."balance" <> 0)
    `);

    await queryRunner.query(`
      UPDATE "finance_schema"."cashbox_cards" c
         SET "deactivated_at" = clock_timestamp()
        FROM "finance_schema"."cashboxes" cb
       WHERE cb."id" = c."cashbox_id"
         AND cb."cashbox_type" = 'branch'
         AND c."deactivated_at" IS NULL
    `);

    // 3) Ochiq filial smenasi: ochilishdagi karta surati jamiga. Qoida
    // servisdagi `shiftCashboxType` bilan bir xil: `cashbox_user_id` 0 / NULL
    // emas — filial smenasi (kassa qatori bo'lmasa ham).
    await queryRunner.query(`
      INSERT INTO "finance_schema"."branch_shift_backup_245"
        ("shift_id", "opening_balance_cash", "opening_balance_card")
      SELECT s."id", s."opening_balance_cash", s."opening_balance_card"
        FROM "finance_schema"."shifts" s
       WHERE s."status" = 'open'
         AND s."opening_balance_card" <> 0
         AND COALESCE(s."cashbox_user_id", 0) <> 0
      ON CONFLICT ("shift_id") DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE "finance_schema"."shifts" s
         SET "opening_balance_cash" =
               s."opening_balance_cash" + s."opening_balance_card",
             "opening_balance_card" = 0
       WHERE s."status" = 'open'
         AND s."opening_balance_card" <> 0
         AND COALESCE(s."cashbox_user_id", 0) <> 0
    `);

    await restore();
  }

  /**
   * Zaxiradan tiklash (faqat jami o'zgarmagan kassalarda — pastdagi izoh):
   * kassa, nomli kartalar va ochiq smena — asl bo'linish. Zaxira jadvallari
   * olib tashlanadi. `balance` hech qachon o'zgarmaydi.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const restore = await this.lockTimeout(queryRunner);
    // Zaxira yo'q (up yurmagan yoki down allaqachon bajarilgan) — no-op.
    const [{ present }] = (await queryRunner.query(
      `SELECT to_regclass('"finance_schema"."branch_cashbox_backup_245"') IS NOT NULL
          AND to_regclass('"finance_schema"."branch_card_backup_245"') IS NOT NULL
          AND to_regclass('"finance_schema"."branch_shift_backup_245"') IS NOT NULL
          AS present`,
    )) as Array<{ present: boolean }>;
    if (!present) {
      await restore();
      return;
    }
    /**
     * Tiklash FAQAT xavfsiz kassalarda: jami (naqd + karta) up() dagi
     * suratdan beri O'ZGARMAGAN. Filial pul sarflagan / olgan bo'lsa eski
     * bo'linishni qaytarish naqdni chuqur manfiyga, kartaga esa yo'q pulni
     * yozardi — eski kod «fantom» karta pulidan click chiqimga ruxsat berardi.
     * Bunday kassalar bitta jamida (hammasi naqd, karta 0) qoladi, ularning
     * nomli kartalari 0 va nofaol, ochiq smenasi — jami bilan.
     * Tartib: kartalar va smenalar AVVAL (shart kassaning hozirgi holatiga
     * qaraydi), kassa — oxirida.
     */
    const restorable = `
      SELECT cb."id", cb."user_id"
        FROM "finance_schema"."cashboxes" cb
        JOIN "finance_schema"."branch_cashbox_backup_245" bc
          ON bc."cashbox_id" = cb."id"
       WHERE cb."cashbox_type" = 'branch'
         AND cb."balance_cash" + cb."balance_card"
             = bc."balance_cash" + bc."balance_card"`;
    await queryRunner.query(`
      UPDATE "finance_schema"."cashbox_cards" c
         SET "balance" = b."balance",
             "is_active" = b."is_active",
             -- F3: up() va down() orasida (qoldiq 0 bilan) o'chirilgan pulli
             -- karta — to'liq orqaga (aks holda qoldig'ini «Asosiy karta»
             -- yutardi). 245 dan keyin filial kartasi yaratilmaydi — nom
             -- to'qnashuvi yo'q.
             "is_deleted" = CASE WHEN b."balance" <> 0 THEN false
                                 ELSE c."is_deleted" END
        FROM "finance_schema"."branch_card_backup_245" b
       WHERE b."card_id" = c."id"
         AND (
           c."cashbox_id" IN (SELECT r."id" FROM (${restorable}) r)
           -- karta qismi bo'lmagan kassa (zaxirada yo'q): faqat pulsiz karta
           OR (
             b."balance" = 0
             AND c."cashbox_id" NOT IN (
               SELECT "cashbox_id" FROM "finance_schema"."branch_cashbox_backup_245"
             )
           )
         )
    `);
    await queryRunner.query(`
      UPDATE "finance_schema"."shifts" s
         SET "opening_balance_cash" = b."opening_balance_cash",
             "opening_balance_card" = b."opening_balance_card"
        FROM "finance_schema"."branch_shift_backup_245" b
       WHERE b."shift_id" = s."id" AND s."status" = 'open'
         -- F2: kassasiz / karta qismi 0 (zaxirasiz kassa) filial smenasi ham
         -- tiklanadi; faqat jami o'zgargan (tiklanmaydigan) kassa smenasi —
         -- jami bilan qoladi.
         AND COALESCE(s."cashbox_user_id", 0) NOT IN (
           SELECT cb."user_id"
             FROM "finance_schema"."cashboxes" cb
             JOIN "finance_schema"."branch_cashbox_backup_245" bc
               ON bc."cashbox_id" = cb."id"
            WHERE cb."cashbox_type" = 'branch'
              AND cb."user_id" IS NOT NULL
              AND cb."id" NOT IN (SELECT r."id" FROM (${restorable}) r)
         )
    `);
    await queryRunner.query(`
      UPDATE "finance_schema"."cashboxes" cb
         SET "balance_cash" = b."balance_cash",
             "balance_card" = b."balance_card"
        FROM "finance_schema"."branch_cashbox_backup_245" b
       WHERE b."cashbox_id" = cb."id"
         AND cb."id" IN (SELECT r."id" FROM (${restorable}) r)
    `);
    // N1: migratsiya jurnal qatorlari — faqat tiklangan kassalarda (u yerda
    // karta qoldiqlari qaytdi); qolganlarida karta 0 bo'lib qoladi, qator ham.
    await queryRunner.query(`
      DELETE FROM "finance_schema"."cashbox_card_movements" m
       WHERE m."dedup_epoch" LIKE 'migration-245:card:%'
         AND m."cashbox_id" IN (SELECT r."id" FROM (${restorable}) r)
    `);
    await queryRunner.query(`
      UPDATE "finance_schema"."cashbox_cards" c
         SET "deactivated_at" = NULL
       WHERE c."deactivated_at" IS NOT NULL
         -- Y-2: tiklangan kassaning HAMMA kartalari (qayta up() yangi kesim
         -- va yangi jurnal qatori yozsin), boshqalarida — faol bo'lganlari.
         AND (
           c."is_active" = true
           OR c."cashbox_id" IN (SELECT r."id" FROM (${restorable}) r)
         )
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."branch_shift_backup_245"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."branch_card_backup_245"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."branch_cashbox_backup_245"`,
    );
    await restore();
  }

  /** `lock_timeout` 5 s (tranzaksiya ichida, `is_local`); qaytaruvchi funksiya. */
  private async lockTimeout(
    queryRunner: QueryRunner,
  ): Promise<() => Promise<void>> {
    const [{ previous }] = (await queryRunner.query(
      `SELECT current_setting('lock_timeout') AS previous`,
    )) as Array<{ previous: string }>;
    await queryRunner.query(`SELECT set_config('lock_timeout', '5s', true)`);
    return async () => {
      await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
        previous,
      ]);
    };
  }
}
