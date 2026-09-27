import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * bVeyEuIR #11 — bitta-buyurtma (single) yo'li kodda UMUMAN yo'q.
 *
 * BeePost'da `extractDraft()` (feature 'order_extract', maxTokens berilmagan
 * → sukut 1024) sinalmagan yo'l edi va uzun matnni jimgina kesardi. Elchida
 * hamma parse DOIM ko'p-buyurtma sxemasi bilan ketadi: feature faqat
 * 'order_extract_multi' (matn) yoki 'order_extract_image' (rasm).
 *
 * Statik skan: apps/ai-service/src va libs/common/src/ai.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const SCAN_DIRS = ['apps/ai-service/src', 'libs/common/src/ai'];
const SELF = resolve(__filename);

// Qidiriladigan so'zlar bo'laklardan yig'iladi — bu faylning o'zi skanda
// topilib qolmasin (u baribir chiqarib tashlanadi).
const SINGLE_PATH_FN = ['extract', 'Draft'].join('');
const FEATURE_PREFIX = ['order', 'extract'].join('_');

/** Ruxsat etilgan feature literallari (va prefiks shakli). */
const ALLOWED_LITERALS = new Set([
  `${FEATURE_PREFIX}_multi`,
  `${FEATURE_PREFIX}_image`,
  // `feature.startsWith('order_extract_')` kabi PREFIKS tekshiruvi — feature
  // nomi emas (masalan applied_price_uzs faqat order_extract_* uchun).
  `${FEATURE_PREFIX}_`,
]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '__snapshots__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => listTsFiles(join(REPO_ROOT, d))).filter(
  (f) => resolve(f) !== SELF,
);

describe('bVeyEuIR #11 — single-path guard (statik)', () => {
  it('skan bo‘sh emas (ai-service va libs/common/src/ai fayllari topildi)', () => {
    const rel = FILES.map((f) => relative(REPO_ROOT, f));
    expect(rel.some((f) => f.startsWith('apps/ai-service/src/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('libs/common/src/ai/'))).toBe(true);
    expect(rel).toContain('libs/common/src/ai/claude.service.ts');
  });

  it(`hech qayerda '${SINGLE_PATH_FN}' yo‘q`, () => {
    const hits = FILES.filter((f) =>
      readFileSync(f, 'utf8').includes(SINGLE_PATH_FN),
    ).map((f) => relative(REPO_ROOT, f));
    expect(hits).toEqual([]);
  });

  it(`'${FEATURE_PREFIX}' literali faqat _multi / _image shaklida`, () => {
    const literal = new RegExp(
      `(['"\`])(${FEATURE_PREFIX}[A-Za-z0-9_]*)\\1`,
      'g',
    );
    // Dinamik yig'ilgan feature nomi (`order_extract_${x}`) ham taqiqlanadi.
    const dynamic = new RegExp(`${FEATURE_PREFIX}_?\\$\\{`);
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(literal)) {
        if (!ALLOWED_LITERALS.has(m[2])) {
          offenders.push(`${relative(REPO_ROOT, file)}: ${m[0]}`);
        }
      }
      if (dynamic.test(src)) {
        offenders.push(`${relative(REPO_ROOT, file)}: dinamik feature nomi`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("AiFeature tipida 'order_extract' (single) varianti yo‘q", () => {
    const types = readFileSync(
      join(REPO_ROOT, 'libs/common/src/ai/claude.types.ts'),
      'utf8',
    );
    expect(types).toContain(`'${FEATURE_PREFIX}_multi'`);
    expect(types).toContain(`'${FEATURE_PREFIX}_image'`);
    expect(types).not.toMatch(new RegExp(`'${FEATURE_PREFIX}'`));
  });
});
