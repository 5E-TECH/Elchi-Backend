import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * i6Nyedea — jurnal ARXIVI (cold jadval): `activity_logs_archive` HAR audit
 * sxemasida (karta 5-band: "o'chirishdan oldin arxiv — moliyaviy/huquqiy
 * dalil yo'qolmasin").
 *
 * Saqlash muddati o'tgan qatorlar (`ACTIVITY_LOG_PRUNE_ENABLED=true`
 * bo'lganda) hot jadvaldan o'chirilmaydi, shu jadvalga KO'CHIRILADI —
 * `buildPolicyArchiveSql` (bitta SQL buyrug'i: DELETE ... RETURNING →
 * INSERT). Bayroq sukut bo'yicha O'CHIQ: bu migratsiyadan keyin ham prod'da
 * hech narsa ko'chmaydi/o'chmaydi.
 *
 * Ro'yxat — 062 dagi 10 sxema (9 jurnal servisi + `ai_schema`); spec uni
 * 062 ro'yxati bilan solishtiradi (u esa kodning o'zi bilan tekshirilgan).
 * Hot jadvali yo'q sxemada jimgina o'tadi.
 *
 * Ustunlar `ActivityLog` bilan AYNAN bir xil tur/uzunlikda + `archived_at`,
 * `archive_rule`. `id` — ASL id (ketma-ketlik yo'q, PRIMARY KEY): bir qator
 * ikki marta arxivlansa PK xatosi butun partiyani bekor qiladi.
 *
 * ⚠️ Mavjud ma'lumotga TEGMAYDI: faqat bo'sh jadval va indekslar yaratiladi.
 *
 * down(): arxiv BO'SH bo'lsa jadval tushiriladi; qator bo'lsa — RAD etadi
 * (arxivlangan dalil migratsiya qaytarilishida jimgina yo'qolmasin). Kerak
 * bo'lsa avval qatorlarni qo'lda qaytaring yoki eksport qiling.
 */
export const ACTIVITY_LOG_ARCHIVE_SCHEMAS: readonly string[] = [
  'order_schema',
  'finance_schema',
  'identity_schema',
  'branch_schema',
  'integration_schema',
  'logistics_schema',
  'catalog_schema',
  'investor_schema',
  'notification_schema',
  'ai_schema',
];

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export class CreateActivityLogsArchive1716000000101 implements MigrationInterface {
  name = 'CreateActivityLogsArchive1716000000101';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const schema of ACTIVITY_LOG_ARCHIVE_SCHEMAS) {
      const archive = `${q(schema)}."activity_logs_archive"`;
      await queryRunner.query(`
        DO $$ BEGIN
          IF to_regclass('${q(schema)}."activity_logs"') IS NOT NULL THEN
            CREATE TABLE IF NOT EXISTS ${archive} (
              "id" BIGINT NOT NULL,
              "entity_type" VARCHAR(64) NOT NULL,
              "entity_id" VARCHAR(100) NOT NULL,
              "action" VARCHAR(64) NOT NULL,
              "old_value" JSONB NULL,
              "new_value" JSONB NULL,
              "user_id" VARCHAR(100) NULL,
              "user_name" VARCHAR(200) NULL,
              "user_role" VARCHAR(32) NULL,
              "service" VARCHAR(32) NULL,
              "trace_id" VARCHAR(64) NULL,
              "metadata" JSONB NULL,
              "description" TEXT NULL,
              "created_at" TIMESTAMPTZ NOT NULL,
              "archived_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
              "archive_rule" VARCHAR(32) NULL,
              CONSTRAINT "PK_ACTIVITY_ARCHIVE_${schema}" PRIMARY KEY ("id")
            );
            CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ARCHIVE_ENTITY_${schema}"
              ON ${archive} ("entity_type", "entity_id", "created_at");
            CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ARCHIVE_USER_${schema}"
              ON ${archive} ("user_id", "created_at");
            CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ARCHIVE_CREATED_${schema}"
              ON ${archive} ("created_at");
          END IF;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Avval HAMMA sxema tekshiriladi — qisman tushirish bo'lmasin.
    const nonEmpty: string[] = [];
    for (const schema of ACTIVITY_LOG_ARCHIVE_SCHEMAS) {
      const [exists] = (await queryRunner.query(
        `SELECT to_regclass($1) IS NOT NULL AS ok`,
        [`${q(schema)}."activity_logs_archive"`],
      )) as Array<{ ok?: boolean }>;
      if (exists?.ok === false) continue;
      const [row] = (await queryRunner.query(
        `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM ${q(schema)}."activity_logs_archive" LIMIT 1) AS x`,
      )) as Array<{ n?: number | string }>;
      if (Number(row?.n ?? 0) > 0) nonEmpty.push(schema);
    }
    if (nonEmpty.length) {
      throw new Error(
        `activity_logs_archive bo'sh emas (${nonEmpty.join(', ')}) — arxivlangan jurnal dalili yo'qolmasligi uchun down() rad etildi. ` +
          `Avval qatorlarni eksport qiling yoki hot jadvalga qaytaring.`,
      );
    }
    for (const schema of ACTIVITY_LOG_ARCHIVE_SCHEMAS) {
      await queryRunner.query(
        `DROP TABLE IF EXISTS ${q(schema)}."activity_logs_archive"`,
      );
    }
  }
}
