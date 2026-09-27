import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as counterModule from '../usage/ai-spend-counter.service';
import { AiBudgetService } from './ai-budget.service';

/**
 * KVOTA YO'Q (wFSMEIIy #19, ega qarori 2026-09-19).
 *
 * Global kunlik shift — AVARIYA TO'XTATGICHI, kvota emas: market yoki
 * foydalanuvchi kesimida hisob/tekshiruv QURILMAYDI. Bu test shift
 * mantiqining ikkala faylini statik skanerlaydi: kodda (izohlardan
 * tashqari), SQL'da va metod imzolarida market/foydalanuvchi
 * identifikatori bo'lmasligi SHART.
 *
 * ⚠️ YAGONA ISTISNO — `raise()` audit yozuvidagi AKTYOR
 * (`user_id: actor` — kim shiftni ko'tardi). Bu `activity_logs`
 * jadvalining standart maydoni, kvota kaliti emas; istisno aynan shu
 * bitta qator bilan cheklangan.
 */
const FILES = {
  budget: join(__dirname, 'ai-budget.service.ts'),
  counter: join(__dirname, '..', 'usage', 'ai-spend-counter.service.ts'),
};

const QUOTA_KEY_SOURCE = String.raw`\b(market_?id|marketId|user_?id|userId)\b`;
/** Qatorni tekshirish uchun (global EMAS — `lastIndex` holati yo'q). */
const QUOTA_KEY_TEST = new RegExp(QUOTA_KEY_SOURCE, 'i');
/** Fayldagi barcha uchrashuvlarni sanash uchun. */
const QUOTA_KEY_ALL = new RegExp(QUOTA_KEY_SOURCE, 'gi');
const ALLOWED = new Set(['budget:user_id: actor,']);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Kvota yo`q — shift faqat global (wFSMEIIy #19)', () => {
  it.each(Object.entries(FILES))(
    '%s: kodda market/foydalanuvchi identifikatori yo`q (audit aktyoridan tashqari)',
    (label, file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      const hits = code
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => QUOTA_KEY_TEST.test(line))
        .map((line) => `${label}:${line}`)
        .filter((hit) => !ALLOWED.has(hit));
      expect(hits).toEqual([]);
    },
  );

  it('istisno haqiqatan mavjud va bitta (ro`yxat eskirmasin)', () => {
    const code = stripComments(readFileSync(FILES.budget, 'utf8'));
    const matches = code.match(QUOTA_KEY_ALL) ?? [];
    expect(matches).toEqual(['user_id']);
    expect(code).toContain('user_id: actor,');
  });

  it('SQL satrlarida market/user ustuni yo`q, faqat scope/period_key', () => {
    const sqls = Object.entries(counterModule)
      .filter(([name]) => name.endsWith('_SQL'))
      .map(([name, value]) => [name, String(value)] as const);
    expect(sqls.map(([name]) => name).sort()).toEqual([
      'AI_SPEND_ADD_OVERRIDE_SQL',
      'AI_SPEND_ADD_SQL',
      'AI_SPEND_MARK_EXCEEDED_SQL',
      'AI_SPEND_MARK_WARNED_SQL',
      'AI_SPEND_READ_SQL',
    ]);
    for (const [name, sql] of sqls) {
      expect({ name, market_or_user: /market|user/i.test(sql) }).toEqual({
        name,
        market_or_user: false,
      });
      expect(sql).toContain('ai_schema.ai_spend_counter');
      expect(sql).toMatch(/scope|'global'/);
    }
  });

  it('public metod imzolarida market/user parametri yo`q', () => {
    const paramNames = (fn: unknown): string[] => {
      const src = String(fn);
      const open = src.indexOf('(');
      const close = src.indexOf(')', open);
      return src
        .slice(open + 1, close)
        .split(',')
        .map((p) => p.replace(/=.*$/, '').trim())
        .filter(Boolean);
    };
    const methods: Array<[string, unknown]> = [
      ...Object.getOwnPropertyNames(AiBudgetService.prototype).map(
        (n): [string, unknown] => [
          `AiBudgetService.${n}`,
          (AiBudgetService.prototype as unknown as Record<string, unknown>)[n],
        ],
      ),
      ...Object.getOwnPropertyNames(
        counterModule.AiSpendCounterService.prototype,
      ).map((n): [string, unknown] => [
        `AiSpendCounterService.${n}`,
        (
          counterModule.AiSpendCounterService.prototype as unknown as Record<
            string,
            unknown
          >
        )[n],
      ]),
    ];
    expect(methods.length).toBeGreaterThan(5);
    const offenders = methods
      .filter(([name]) => !name.endsWith('.constructor'))
      .flatMap(([name, fn]) =>
        paramNames(fn)
          .filter((p) => /market|user/i.test(p))
          .map((p) => `${name}(${p})`),
      );
    expect(offenders).toEqual([]);
  });
});
