import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * notification-service'da AI YO'Q (Gy8Lt6KT #12).
 *
 * ⚠️ Bot AI'ni o'zi chaqirmasligi kerak: aks holda ai-service'dagi promptning
 * IKKINCHI nusxasi paydo bo'ladi (ikki joyda tahrirlanadi, bir-biridan
 * uzoqlashadi) va xarajat/limit nazoratini chetlab o'tadi. Bot AI buyurtma
 * qilmoqchi bo'lsa, gateway'dagi `orders/ai-parse` ni chaqirsin.
 *
 * Bu test `apps/notification-service/src` ichidagi barcha `.ts` manbalarni
 * (spec'lardan tashqari) statik skanerlaydi va quyidagilar YO'QLIGINI
 * tekshiradi:
 *  1. Anthropic SDK importi/require'i;
 *  2. umumiy Claude klienti (servis yoki modul) ishlatilishi;
 *  3. `<NOM>_SYSTEM =` ko'rinishidagi prompt konstantalari (ai-service'dagi
 *     `ORDER_EXTRACT_SYSTEM`/`PRODUCT_DISAMBIG_SYSTEM` naqshi).
 */

const SRC_DIR = __dirname;

// Qoidalar nomi skanerlanadigan fayllarda literal ko'rinmasligi uchun
// qismlardan yig'iladi (bu fayl spec, u baribir skanerlanmaydi).
const SDK_NAME = ['@anthropic-ai', 'sdk'].join('/');
const CLAUDE_CLIENT = 'Claude';

interface Rule {
  name: string;
  re: RegExp;
}

const RULES: Rule[] = [
  {
    name: 'Anthropic SDK import',
    re: new RegExp(`['"\`]${SDK_NAME.replace(/[/.-]/g, (c) => `\\${c}`)}`),
  },
  {
    name: 'shared Claude client usage',
    re: new RegExp(`\\b${CLAUDE_CLIENT}(?:Service|Module)\\b`),
  },
  {
    name: 'prompt constant (<NAME>_SYSTEM =)',
    re: /\b[A-Z][A-Z0-9_]*_SYSTEM(?:_PROMPT)?\s*(?::[^=\n]+)?=(?!=)/,
  },
];

const listSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : [];
  });

const findViolations = (src: string): string[] => {
  const hits: string[] = [];
  src.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) hits.push(`${i + 1}: ${rule.name}`);
    }
  });
  return hits;
};

describe('notification-service AI ishlatmaydi (Gy8Lt6KT #12)', () => {
  const files = listSources(SRC_DIR);

  it("skaner bo'sh emas — order bot fayli ham ichida", () => {
    const rel = files.map((f) => relative(SRC_DIR, f));
    expect(rel).toContain('order-bot.update.ts');
    expect(rel).toContain('notification-bot.update.ts');
    expect(rel.some((f) => f.endsWith('.spec.ts'))).toBe(false);
  });

  it("manbalarda Anthropic importi, Claude klienti va *_SYSTEM prompt yo'q", () => {
    const violations = files.flatMap((file) =>
      findViolations(readFileSync(file, 'utf8')).map(
        (hit) => `${relative(SRC_DIR, file)}:${hit}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it('detektor haqiqatan ushlaydi (musbat nazorat)', () => {
    const sdk = `import Anthropic from '${SDK_NAME}';`;
    const req = `const sdk = require("${SDK_NAME}");`;
    const svc = `constructor(private readonly claude: ${CLAUDE_CLIENT}Service) {}`;
    const mod = `imports: [${CLAUDE_CLIENT}Module.forRoot({})],`;
    const prompt = 'export const ORDER_EXTRACT_SYSTEM = `Siz ...`;';
    const typed = 'const BOT_SYSTEM_PROMPT: string = "...";';

    expect(findViolations(sdk)).toEqual(['1: Anthropic SDK import']);
    expect(findViolations(req)).toEqual(['1: Anthropic SDK import']);
    expect(findViolations(svc)).toEqual(['1: shared Claude client usage']);
    expect(findViolations(mod)).toEqual(['1: shared Claude client usage']);
    expect(findViolations(prompt)).toEqual([
      '1: prompt constant (<NAME>_SYSTEM =)',
    ]);
    expect(findViolations(typed)).toEqual([
      '1: prompt constant (<NAME>_SYSTEM =)',
    ]);

    // Soxta signal yo'q: taqqoslash va oddiy matn ushlanmaydi.
    expect(findViolations('if (x.type === ROLE_SYSTEM) {}')).toEqual([]);
    expect(findViolations("category: 'system',")).toEqual([]);
    expect(findViolations('if (MODE_SYSTEM == mode) {}')).toEqual([]);
  });
});
