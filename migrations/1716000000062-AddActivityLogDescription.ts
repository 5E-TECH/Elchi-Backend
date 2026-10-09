import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `activity_logs.description` — inson o'qiy oladigan o'zbekcha gap (2WRzdWpZ).
 *
 * BITTA migratsiya, sxemalar massivi bo'ylab — mavjud naqsh
 * `1716000000009-ExtendActivityLogsCoverage.ts` (`ALL_AUDIT_SCHEMAS`). 9 ta
 * alohida fayl YOZILMAGAN: repoda servis bo'yicha migrations papkasi yo'q va
 * alohida fayllar "birortasi unutiladi" xavfini oshiradi.
 *
 * ⚠️ RO'YXAT 9 EMAS, 10 TA. Kartadagi 9 sxemadan tashqari `ai_schema` ham
 * `activity_logs` ga ega (1716000000047-CreateAiSchema, ai-service
 * `ActivityLogModule.forService('ai-service')`). Entity'ga ustun qo'shilgani
 * uchun ustuni YO'Q sxemada HAR INSERT yiqiladi va `log()` xatoni yutadi —
 * ya'ni o'sha servis jurnali JIMGINA yozilmay qoladi. Ro'yxat to'liqligini
 * `activity-log.description-migration.spec.ts` kod bilan solishtirib
 * tekshiradi (ActivityLogModule ishlatadigan har servisning DB_SCHEMA si).
 *
 * Qidiruv: `description ILIKE '%…%'` indekssiz to'liq skan. pg_trgm kengaytmasi
 * allaqachon yoqilgan (1714700000000-AddSearchTrigramIndexes) — bu yerda faqat
 * GIN `gin_trgm_ops` indeksi quriladi. Operator klassi kengaytma o'rnatilgan
 * sxema bilan aniq ko'rsatiladi (search_path'ga bog'liq bo'lmasin). Indeks
 * qisman (`WHERE description IS NOT NULL`): eski qatorlar NULL, ILIKE esa NULL
 * qatorni hech qachon topmaydi — planner qisman indeksni baribir ishlatadi.
 *
 * Ustun yangi va NULL — `ADD COLUMN` faqat metama'lumot o'zgarishi (jadval
 * qayta yozilmaydi); indeks qurilishi jadvalni bir marta skan qiladi.
 */
export const ACTIVITY_LOG_DESCRIPTION_SCHEMAS: readonly string[] = [
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

const INDEX_PREFIX = 'IDX_ACTIVITY_DESCRIPTION_TRGM';

export class AddActivityLogDescription1716000000062 implements MigrationInterface {
  name = 'AddActivityLogDescription1716000000062';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const ext = (await queryRunner.query(
      `SELECT n.nspname AS schema
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pg_trgm'`,
    )) as Array<{ schema: string }>;
    const trgmSchema = ext[0]?.schema;
    if (!trgmSchema) {
      throw new Error(
        'pg_trgm kengaytmasi topilmadi — 1714700000000-AddSearchTrigramIndexes avval ishlashi kerak',
      );
    }

    for (const schema of ACTIVITY_LOG_DESCRIPTION_SCHEMAS) {
      // Jadval bo'lmagan sxemada (masalan, hali yaratilmagan) jimgina o'tadi.
      await queryRunner.query(`
        DO $$ BEGIN
          IF to_regclass('"${schema}"."activity_logs"') IS NOT NULL THEN
            ALTER TABLE "${schema}"."activity_logs"
              ADD COLUMN IF NOT EXISTS "description" TEXT NULL;
            CREATE INDEX IF NOT EXISTS "${INDEX_PREFIX}_${schema}"
              ON "${schema}"."activity_logs"
              USING gin ("description" "${trgmSchema}".gin_trgm_ops)
              WHERE "description" IS NOT NULL;
          END IF;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const schema of ACTIVITY_LOG_DESCRIPTION_SCHEMAS) {
      await queryRunner.query(
        `DROP INDEX IF EXISTS "${schema}"."${INDEX_PREFIX}_${schema}"`,
      );
      await queryRunner.query(`
        DO $$ BEGIN
          IF to_regclass('"${schema}"."activity_logs"') IS NOT NULL THEN
            ALTER TABLE "${schema}"."activity_logs"
              DROP COLUMN IF EXISTS "description";
          END IF;
        END $$;
      `);
    }
    // pg_trgm kengaytmasiga TEGILMAYDI — search_schema indekslari unga tayanadi.
  }
}
