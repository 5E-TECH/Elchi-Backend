import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { evaluateModelPolicy } from './ai-model-policy';

/**
 * M2 / M3 — Anthropic so'rov tanasi QULFI (manba kodi bo'yicha).
 *
 * M3: 5.5 avlodida (va Fable 5.x da) quyidagilar 400 qaytaradi:
 *  - majburiy `tool_choice` (`any` / `tool`);
 *  - `thinking: { type: 'disabled' }` va `budget_tokens`;
 *  - `temperature` / `top_p` / `top_k` (2026-10-21 API versiyasida hamma
 *    modelda).
 * Hozir hech biri ishlatilmaydi — qaytib kirmasligi uchun shu test.
 *
 * M2: har Claude chaqiruvi `effort`ni `effortParam()` orqali ANIQ yuboradi —
 * 5.5 da sukut effort baland, kichik max_tokens thinking'ga ketib javob
 * kesiladi.
 */
const ROOT = resolve(__dirname, '../../../..');
const SCAN_DIRS = ['apps/ai-service/src', 'libs/common/src/ai'];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.d.ts') &&
      !name.includes('type-test')
    ) {
      out.push(p);
    }
  }
  return out;
}

/** Izohlarni olib tashlaydi (satr ichidagi `//` URL'lar kamdan-kam — yetarli). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const files = SCAN_DIRS.flatMap((d) => tsFiles(join(ROOT, d))).map((p) => ({
  path: relative(ROOT, p),
  code: stripComments(readFileSync(p, 'utf8')),
}));

describe('M3: 5.5 avlodida rad etiladigan so‘rov parametrlari kodda yo‘q', () => {
  it('manba fayllari topildi', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  const forbidden: Array<[string, RegExp]> = [
    [
      'majburiy tool_choice (any/tool)',
      /tool_choice[\s\S]{0,80}?type\s*:\s*['"](any|tool)['"]/,
    ],
    ['budget_tokens', /\bbudget_tokens\b/],
    [
      "thinking: { type: 'disabled' }",
      /thinking\s*:\s*\{[^}]*['"]disabled['"]/,
    ],
    ['temperature / top_p / top_k', /\b(temperature|top_p|top_k)\s*:/],
  ];

  it.each(forbidden)('%s', (_label, re) => {
    const hits = files.filter((f) => re.test(f.code)).map((f) => f.path);
    expect(hits).toEqual([]);
  });
});

describe('M2: har Claude chaqiruvi effortni effortParam() orqali yuboradi', () => {
  /** `.extractJson(` / `.runToolLoop(` chaqiruvi argumentlari (qavs balansi). */
  function callArgs(code: string, start: number): string {
    let depth = 0;
    for (let i = code.indexOf('(', start); i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return code.slice(start, i + 1);
    }
    return code.slice(start);
  }

  const calls = files
    .filter((f) => !f.path.startsWith('libs/'))
    .flatMap((f) =>
      [
        ...f.code.matchAll(/\.(extractJson|runToolLoop)\s*(<[^(]*>)?\s*\(/g),
      ].map((m) => ({ path: f.path, args: callArgs(f.code, m.index) })),
    );

  it('chaqiruvlar topildi (order, district, mahsulot, chek, smena, yordamchi)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('hammasida effortParam(...) bor', () => {
    const missing = calls
      .filter((c) => !/\beffortParam\s*\(/.test(c.args))
      .map((c) => c.path);
    expect(missing).toEqual([]);
  });
});

describe('M1: model siyosati 5.5 avlodini taniydi', () => {
  it('sonnet-5-5 / opus-5-5 — kuchli ekstraksiya; haiku-5-5 — klassifikatsiya uchun ok, ekstraksiya uchun weak', () => {
    expect(
      evaluateModelPolicy({
        order: 'claude-sonnet-5-5',
        vision: 'claude-opus-5-5',
        classify: 'claude-haiku-5-5',
      }),
    ).toEqual({ ok: true, order: 'ok', vision: 'ok', classify: 'ok' });
    expect(
      evaluateModelPolicy({
        order: 'claude-haiku-5-5',
        vision: 'claude-sonnet-5-5',
        classify: 'claude-haiku-5-5',
      }).order,
    ).toBe('weak');
  });
});
