import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Joi from 'joi';
import * as config from '../config';
import {
  ACTIVITY_LOG_DESCRIPTION_SCHEMAS,
  AddActivityLogDescription1716000000062,
} from '../../../../migrations/1716000000062-AddActivityLogDescription';

/**
 * 2WRzdWpZ TC1 / TC10 — `activity_logs.description` HAR audit sxemasida.
 *
 * ⚠️ NEGA STATIK. Loyihada Postgres testlari faqat env bilan ishlaydi
 * (`*.pg.spec.ts`, oddiy `jest` va CI'da skip) — "har sxemada ustun bor"
 * darvozasi DB'ga tayansa, u ishlab chiquvchi mashinasida ham, CI'da ham JIM
 * turardi. Shu sabab bu test DB'siz: migratsiya ro'yxatini KODNING O'ZI bilan
 * solishtiradi — `ActivityLogModule.forService(...)` ishlatadigan har bir
 * servisning `DB_SCHEMA` sukuti (config Joi sxemasidan) va gateway jurnal
 * fan-out ro'yxati. Yangi servis jurnal yoza boshlasa-yu, migratsiyaga
 * qo'shilmasa — shu test yiqiladi (aks holda uning loglari jimgina
 * yo'qolardi: `log()` INSERT xatosini yutadi).
 *
 * Haqiqiy Postgres'dagi tekshiruv: `activity-log.description.pg.spec.ts`.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const APPS = join(ROOT, 'apps');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** `ActivityLogModule.forService(...)` ishlatadigan har servisning DB_SCHEMA si. */
function auditedSchemasFromCode(): Map<string, string> {
  const out = new Map<string, string>();
  for (const app of readdirSync(APPS)) {
    const src = join(APPS, app, 'src');
    let files: string[];
    try {
      files = walk(src);
    } catch {
      continue;
    }
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    if (!/ActivityLogModule\.forService\(/.test(text)) continue;
    const match = /validationSchema:\s*(\w+ValidationSchema)\b/.exec(text);
    if (!match) throw new Error(`${app}: validationSchema topilmadi`);
    const schema = (config as unknown as Record<string, Joi.ObjectSchema>)[
      match[1]
    ];
    const described = schema.describe() as {
      keys: Record<string, { flags?: { default?: unknown } }>;
    };
    const dbSchema = described.keys.DB_SCHEMA?.flags?.default;
    if (typeof dbSchema !== 'string') {
      throw new Error(`${app}: DB_SCHEMA sukuti topilmadi (${match[1]})`);
    }
    out.set(app, dbSchema);
  }
  return out;
}

describe('activity_logs.description migratsiyasi (2WRzdWpZ)', () => {
  it('TC1 ActivityLogModule ishlatadigan HAR servis sxemasi ro`yxatda', () => {
    const fromCode = auditedSchemasFromCode();
    // Test soxta emas: kamida karta sanagan 9 servis + ai-service topilgan.
    expect(fromCode.size).toBeGreaterThanOrEqual(10);
    const missing = [...fromCode.entries()]
      .filter(
        ([, schema]) => !ACTIVITY_LOG_DESCRIPTION_SCHEMAS.includes(schema),
      )
      .map(([app, schema]) => `${app} → ${schema}`);
    expect(missing).toEqual([]);
  });

  it('TC1 gateway /activity-logs fan-out qiladigan har sxema ro`yxatda', () => {
    const src = readFileSync(
      join(APPS, 'api-gateway', 'src', 'audit-gateway.controller.ts'),
      'utf8',
    );
    const legs = [...src.matchAll(/\{\s*name:\s*'(\w+)',\s*client:/g)].map(
      (m) => `${m[1]}_schema`,
    );
    expect(legs.length).toBe(9);
    expect(
      legs.filter((s) => !ACTIVITY_LOG_DESCRIPTION_SCHEMAS.includes(s)),
    ).toEqual([]);
    // ai_schema gateway fan-out'da yo'q, lekin jadvali bor — ro'yxatda bo'lishi SHART.
    expect(ACTIVITY_LOG_DESCRIPTION_SCHEMAS).toContain('ai_schema');
  });

  it('ro`yxatda dublikat yo`q', () => {
    expect(new Set(ACTIVITY_LOG_DESCRIPTION_SCHEMAS).size).toBe(
      ACTIVITY_LOG_DESCRIPTION_SCHEMAS.length,
    );
  });

  const runner = (trgmSchema: string | null) => {
    const sql: string[] = [];
    return {
      sql,
      queryRunner: {
        query: jest.fn((q: string) => {
          sql.push(q);
          if (q.includes('pg_extension')) {
            return Promise.resolve(trgmSchema ? [{ schema: trgmSchema }] : []);
          }
          return Promise.resolve([]);
        }),
      },
    };
  };

  it('up(): har sxemaga TEXT NULL ustun + GIN gin_trgm_ops indeksi', async () => {
    const { sql, queryRunner } = runner('public');
    await new AddActivityLogDescription1716000000062().up(queryRunner as never);
    for (const schema of ACTIVITY_LOG_DESCRIPTION_SCHEMAS) {
      const block = sql.find((q) => q.includes(`"${schema}"."activity_logs"`));
      expect(block).toBeDefined();
      expect(block).toContain(
        'ADD COLUMN IF NOT EXISTS "description" TEXT NULL',
      );
      expect(block).toContain(
        'USING gin ("description" "public".gin_trgm_ops)',
      );
      expect(block).toContain('WHERE "description" IS NOT NULL');
    }
    // Kengaytma YARATILMAYDI (allaqachon yoqilgan — 1714700000000).
    expect(sql.some((q) => /CREATE EXTENSION/i.test(q))).toBe(false);
  });

  it('up(): pg_trgm yo`q bo`lsa aniq xato beradi (jimgina indekssiz qolmaydi)', async () => {
    const { queryRunner } = runner(null);
    await expect(
      new AddActivityLogDescription1716000000062().up(queryRunner as never),
    ).rejects.toThrow(/pg_trgm/);
  });

  it('TC10 down(): har sxemadan indeks va ustun olib tashlanadi', async () => {
    const { sql, queryRunner } = runner('public');
    await new AddActivityLogDescription1716000000062().down(
      queryRunner as never,
    );
    for (const schema of ACTIVITY_LOG_DESCRIPTION_SCHEMAS) {
      expect(sql).toContain(
        `DROP INDEX IF EXISTS "${schema}"."IDX_ACTIVITY_DESCRIPTION_TRGM_${schema}"`,
      );
      expect(
        sql.some(
          (q) =>
            q.includes(`"${schema}"."activity_logs"`) &&
            q.includes('DROP COLUMN IF EXISTS "description"'),
        ),
      ).toBe(true);
    }
    expect(sql.some((q) => /DROP EXTENSION/i.test(q))).toBe(false);
  });
});
