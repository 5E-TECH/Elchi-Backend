import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SlMjauWC (N5) — `districts.sato_code` qisman UNIQUE indeksi: bitta rasmiy
 * SOATO kodi = bitta o'chirilmagan tuman.
 *
 *   UQ_DISTRICT_SATO_CODE_LIVE ON districts (sato_code)
 *     WHERE sato_code IS NOT NULL AND sato_code <> '' AND is_deleted = false
 *
 * NULL (noma'lum kod, 1716000000027) va '' (eski createDistrict yozgan bo'sh
 * qiymat) indeksdan tashqarida — ular ko'p bo'lishi mumkin. Eski oddiy
 * `IDX_DISTRICT_SATO_CODE` (qidiruv uchun, o'chirilganlarni ham qamraydi)
 * qoladi.
 *
 * XAVFSIZLIK: indeks yaratishdan oldin takroriy kodlar sanaladi. Takroriy kod
 * bo'lsa migratsiya YIQILMAYDI va ma'lumotga TEGMAYDI — indeks yaratilmaydi,
 * WARNING bilan takroriy kodlar ro'yxati loglanadi (qo'lda tozalangach
 * migratsiyani qayta yurgizish kerak: `down` + `up` yoki indeksni qo'lda).
 * 2026-10-26 prod tekshiruvi: 181 tuman, takroriy kod 0.
 *
 * Qayta yurgizish xavfsiz (IF NOT EXISTS). Sxema nomi konstruktorda (sukut
 * `logistics_schema`) — spec alohida sxemada yurgizishi uchun.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export const DISTRICT_SATO_UNIQUE_INDEX = 'UQ_DISTRICT_SATO_CODE_LIVE';

export class DistrictSatoCodeUnique1716000000160 implements MigrationInterface {
  name = 'DistrictSatoCodeUnique1716000000160';

  private readonly schema: string;

  constructor(schema = 'logistics_schema') {
    if (!SCHEMA_NAME.test(schema)) {
      throw new Error(
        'DistrictSatoCodeUnique1716000000160: noto‘g‘ri sxema nomi',
      );
    }
    this.schema = schema;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const s = this.schema;
    await queryRunner.query(`
      DO $$
      DECLARE
        dup_count integer;
        dup_list text;
      BEGIN
        SELECT count(*), string_agg(d.sato_code || ' x' || d.n, ', ')
          INTO dup_count, dup_list
          FROM (
            SELECT "sato_code", count(*) AS n
              FROM "${s}"."districts"
             WHERE "sato_code" IS NOT NULL
               AND "sato_code" <> ''
               AND "is_deleted" = false
             GROUP BY "sato_code"
            HAVING count(*) > 1
          ) d;

        IF dup_count > 0 THEN
          RAISE WARNING 'DistrictSatoCodeUnique1716000000160: % ta takroriy sato_code (%), ${DISTRICT_SATO_UNIQUE_INDEX} YARATILMADI — ma''lumot qo''lda tozalansin',
            dup_count, dup_list;
        ELSE
          CREATE UNIQUE INDEX IF NOT EXISTS "${DISTRICT_SATO_UNIQUE_INDEX}"
            ON "${s}"."districts" ("sato_code")
            WHERE "sato_code" IS NOT NULL
              AND "sato_code" <> ''
              AND "is_deleted" = false;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${this.schema}"."${DISTRICT_SATO_UNIQUE_INDEX}"`,
    );
  }
}
