import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * AI RPC'lari QAYTA YUBORILMAYDI (Gy8Lt6KT #1).
 *
 * ⚠️ MUAMMO. `rmqSend` timeout'da so'rovni qayta yuboradi (sukut `retries ?? 2`).
 * Oddiy RPC uchun bu zararsiz (handler'lar idempotent), lekin AI chaqiruvi
 * BEKOR QILINMAYDI: kechikkan birinchi xabar ai-service'da baribir bajariladi
 * va har bir qayta urinish Anthropic'ni YANA chaqiradi — 20 s kechikishda bitta
 * parse 3 marta pul yechadi. Gateway esa `rmqSend` emas, `client.send()` +
 * `.pipe(timeout(...))` ishlatadi — u yerda `retry(...)` operatori xuddi
 * shunday xavf.
 *
 * Bu test `apps/<app>/src` ichidagi barcha `.ts` manbalarni (spec'lardan
 * tashqari, izohlar olib tashlangan holda) statik skanerlaydi:
 *
 *  1. `rmqSend(...)` chaqiruvi AI'ga ketsa (naqsh literalida `cmd: 'ai.` yoki
 *     mijoz `aiClient`) — opsiyalarida `retries: 0` yoki `AI_RPC_SEND_OPTIONS`
 *     bo'lishi SHART va nolga teng bo'lmagan `retries:` bo'lmasligi SHART.
 *  2. `this.aiClient.send(...)` (va `cmd: 'ai.` li har qanday
 *     `this.<x>Client.send(...)`) darhol `.pipe(...)` bilan davom etishi,
 *     undan keyingi 200 belgi ichida va pipe argumentlarida `timeout(`
 *     bo'lishi, `retry(` / `retryWhen(` esa bo'lmasligi SHART.
 *
 * ⚠️ Naqshni (`{ cmd: 'ai.…' }`) chaqiruvning ICHIDA literal sifatida yozing —
 * alohida o'zgaruvchiga olingan naqshni statik skaner ko'rmaydi (mijoz nomi
 * `aiClient` bo'lsa baribir ushlanadi).
 *
 * Tuzatish: `rmqSend(this.aiClient, { cmd: 'ai.…' }, payload,
 * { ...AI_RPC_SEND_OPTIONS, timeoutMs: x })` yoki gateway'da
 * `this.aiClient.send(...).pipe(timeout(AI_RPC_TIMEOUT_MS))`.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const APPS_DIR = join(REPO_ROOT, 'apps');

interface Call {
  /** 1-based line of the callee match. */
  line: number;
  /** Captured callee group (client property name for `.send`). */
  callee: string;
  /** Full `(...)` argument text, parens included. */
  args: string;
  /** Index of the call's closing `)`. */
  close: number;
}

interface Violation {
  line: number;
  rule: 'rmqSend-retries' | 'client-send-timeout';
  detail: string;
}

/** Index just past the string/template literal that starts at `i`. */
const skipString = (src: string, i: number): number => {
  const quote = src[i];
  let k = i + 1;
  if (quote !== '`') {
    while (k < src.length && src[k] !== quote && src[k] !== '\n') {
      k += src[k] === '\\' ? 2 : 1;
    }
    return k + 1;
  }
  while (k < src.length && src[k] !== '`') {
    if (src[k] === '\\') {
      k += 2;
    } else if (src[k] === '$' && src[k + 1] === '{') {
      // `${ ... }` — qavslarni sanab o'tamiz, ichidagi satrlar ham o'tkaziladi
      let depth = 1;
      k += 2;
      while (k < src.length && depth > 0) {
        if (src[k] === "'" || src[k] === '"' || src[k] === '`') {
          k = skipString(src, k);
          continue;
        }
        if (src[k] === '{') depth++;
        else if (src[k] === '}') depth--;
        k++;
      }
    } else {
      k++;
    }
  }
  return k + 1;
};

const isQuote = (ch: string | undefined): boolean =>
  ch === "'" || ch === '"' || ch === '`';

/**
 * Izohlarni bo'shliq bilan almashtiradi (qator raqamlari saqlanadi). Aks holda
 * izohdagi "rmqSend(...)" yoki izohdagi apostrof (o'zbekcha matn) skanerni
 * chalg'itadi.
 */
const stripComments = (src: string): string => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (isQuote(src[i])) {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end =
        src[i + 1] === '/'
          ? (() => {
              const nl = src.indexOf('\n', i);
              return nl === -1 ? src.length : nl;
            })()
          : (() => {
              const close = src.indexOf('*/', i + 2);
              return close === -1 ? src.length : close + 2;
            })();
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
};

/** Index of the `)` matching the `(` at `open`, skipping string literals; -1 if unbalanced. */
const matchParen = (src: string, open: number): number => {
  let depth = 0;
  let k = open;
  while (k < src.length) {
    if (isQuote(src[k])) {
      k = skipString(src, k);
      continue;
    }
    if (src[k] === '(') depth++;
    else if (src[k] === ')') {
      depth--;
      if (depth === 0) return k;
    }
    k++;
  }
  return -1;
};

const skipWs = (src: string, k: number): number => {
  while (k < src.length && /\s/.test(src[k])) k++;
  return k;
};

/** Skip an optional `<...>` generic type argument starting at `k`. */
const skipGeneric = (src: string, k: number): number => {
  if (src[k] !== '<') return k;
  let depth = 0;
  while (k < src.length) {
    if (src[k] === '<') depth++;
    else if (src[k] === '>' && src[k - 1] !== '=') {
      depth--;
      if (depth === 0) return k + 1;
    }
    k++;
  }
  return k;
};

/**
 * Every call of `calleeRe` in comment-stripped `src`. The regex matches the
 * callee up to (not including) an optional generic and the `(`; its first
 * capture group, if any, is reported as `callee`.
 */
const findCalls = (src: string, calleeRe: RegExp): Call[] => {
  const calls: Call[] = [];
  const re = new RegExp(calleeRe.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let k = skipWs(src, m.index + m[0].length);
    k = skipWs(src, skipGeneric(src, k));
    if (src[k] !== '(') continue; // import / type reference, not a call
    const close = matchParen(src, k);
    if (close === -1) continue;
    calls.push({
      line: src.slice(0, m.index).split('\n').length,
      callee: m[1] ?? m[0],
      args: src.slice(k, close + 1),
      close,
    });
  }
  return calls;
};

const AI_CMD_RE = /\bcmd\s*:\s*['"`]ai\./;
const AI_CLIENT_RE = /\baiClient\b/;
const RETRIES_ZERO_RE = /\bretries\s*:\s*0(?![\d.])/;
const RETRIES_ANY_RE = /\bretries\s*:\s*([^,}\s]+)/g;
const AI_SEND_OPTIONS_RE = /\bAI_RPC_SEND_OPTIONS\b/;
const TIMEOUT_CALL_RE = /\btimeout\s*\(/;
const RETRY_CALL_RE = /\bretry(When)?\s*\(/;

const RMQ_SEND_RE = /\brmqSend\b/;
const CLIENT_SEND_RE = /this\s*\.\s*(\w+Client)\s*\.\s*send\b/;

/** Rule 1: AI-bound `rmqSend` must never retry. */
const checkRmqSend = (src: string): Violation[] =>
  findCalls(src, RMQ_SEND_RE)
    .filter((c) => AI_CMD_RE.test(c.args) || AI_CLIENT_RE.test(c.args))
    .flatMap((c): Violation[] => {
      const nonZero = [...c.args.matchAll(RETRIES_ANY_RE)]
        .map((r) => r[1])
        .filter((v) => !/^0(?![\d.])/.test(v));
      if (nonZero.length > 0) {
        return [
          {
            line: c.line,
            rule: 'rmqSend-retries',
            detail: `retries: ${nonZero.join(', ')} — AI chaqiruvida faqat 0`,
          },
        ];
      }
      if (!RETRIES_ZERO_RE.test(c.args) && !AI_SEND_OPTIONS_RE.test(c.args)) {
        return [
          {
            line: c.line,
            rule: 'rmqSend-retries',
            detail:
              "opsiyalarda `retries: 0` yoki `AI_RPC_SEND_OPTIONS` yo'q (sukut retries=2)",
          },
        ];
      }
      return [];
    });

/** Rule 2: AI-bound `this.<x>Client.send(...)` must be `.pipe(timeout(...))` with no retry operator. */
const checkClientSend = (src: string): Violation[] =>
  findCalls(src, CLIENT_SEND_RE)
    .filter((c) => c.callee === 'aiClient' || AI_CMD_RE.test(c.args))
    .flatMap((c): Violation[] => {
      const la = skipWs(src, c.close + 1);
      const tail = src.slice(la, la + 200);
      if (!/^\.\s*pipe\s*\(/.test(tail)) {
        return [
          {
            line: c.line,
            rule: 'client-send-timeout',
            detail: `${c.callee}.send() dan keyin darhol .pipe(timeout(...)) yo'q`,
          },
        ];
      }
      const pipeOpen = src.indexOf('(', la);
      const pipeClose = matchParen(src, pipeOpen);
      const pipeArgs =
        pipeClose === -1 ? '' : src.slice(pipeOpen, pipeClose + 1);
      const violations: Violation[] = [];
      if (!TIMEOUT_CALL_RE.test(tail) || !TIMEOUT_CALL_RE.test(pipeArgs)) {
        violations.push({
          line: c.line,
          rule: 'client-send-timeout',
          detail: `${c.callee}.send().pipe(...) ichida (200 belgi ichida) timeout( yo'q`,
        });
      }
      if (RETRY_CALL_RE.test(pipeArgs)) {
        violations.push({
          line: c.line,
          rule: 'client-send-timeout',
          detail: `${c.callee}.send().pipe(...) ichida retry — AI chaqiruvi qayta yuborilmaydi`,
        });
      }
      return violations;
    });

const checkSource = (raw: string): Violation[] => {
  const src = stripComments(raw);
  return [...checkRmqSend(src), ...checkClientSend(src)];
};

/** `apps/<app>/src` ichidagi barcha `.ts` fayllar, spec'larsiz. */
const listAppSources = (): string[] => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
  };
  for (const app of readdirSync(APPS_DIR)) {
    const srcDir = join(APPS_DIR, app, 'src');
    if (existsSync(srcDir) && statSync(srcDir).isDirectory()) walk(srcDir);
  }
  return files.sort();
};

describe('AI RPC no-retry guard (Gy8Lt6KT #1)', () => {
  describe("detektorning o'zi to'g'ri ishlaydi (sintetik namunalar)", () => {
    it.each([
      [
        'opsiyasiz rmqSend',
        "await rmqSend<Resp>(this.aiClient, { cmd: 'ai.product.disambiguate' }, payload);",
      ],
      [
        "retries yo'q",
        "rmqSend(client, { cmd: 'ai.product.disambiguate' }, payload, { timeoutMs: 15000 })",
      ],
      [
        'AI_RPC_SEND_OPTIONS ustidan retries qayta yozilgan',
        "rmqSend(client, { cmd: 'ai.x' }, p, { ...AI_RPC_SEND_OPTIONS, retries: 2 })",
      ],
      [
        "naqsh o'zgaruvchida, lekin mijoz aiClient",
        'rmqSend(this.aiClient, AI_PATTERN, payload, { timeoutMs: 5000 })',
      ],
      [
        "gateway: pipe yo'q",
        "return this.aiClient.send({ cmd: 'ai.order.extract' }, payload);",
      ],
      [
        'gateway: timeout + retry',
        "this.aiClient.send({ cmd: 'ai.order.extract' }, p).pipe(timeout(AI_RPC_TIMEOUT_MS), retry(1))",
      ],
      [
        "gateway: pipe bor, timeout yo'q",
        'this.aiClient.send({ cmd: "ai.status" }, {}).pipe(catchError(() => of(null)))',
      ],
      [
        "boshqa mijoz, lekin ai. buyrug'i",
        "firstValueFrom(this.orderClient.send({ cmd: 'ai.usage.summary' }, q))",
      ],
    ])('%s → buzilish topiladi', (_name, snippet) => {
      expect(checkSource(snippet).length).toBeGreaterThan(0);
    });

    it.each([
      [
        'retries: 0',
        "rmqSend(this.aiClient, { cmd: 'ai.product.disambiguate' }, p, { timeoutMs: Math.min(15000, left), retries: 0 })",
      ],
      [
        'AI_RPC_SEND_OPTIONS',
        "rmqSend(client, { cmd: 'ai.x' }, p, AI_RPC_SEND_OPTIONS)",
      ],
      [
        'spread + timeoutMs, satr ichida qavs',
        "rmqSend(client, { cmd: 'ai.x' }, { note: 'a (b' }, { ...AI_RPC_SEND_OPTIONS, timeoutMs: t })",
      ],
      [
        "AI bo'lmagan rmqSend tegilmaydi",
        "rmqSend(this.catalogClient, { cmd: 'catalog.product.find_all' }, q)",
      ],
      [
        "izohdagi rmqSend(...) e'tiborsiz",
        "// rmqSend(this.aiClient, { cmd: 'ai.x' }, p) — o'rniga AI_RPC_SEND_OPTIONS\nconst x = 1;",
      ],
      [
        "gateway: generic + ko'p qatorli pipe(timeout)",
        [
          'const reply = await firstValueFrom(',
          '  this.aiClient',
          '    .send<AiOrderExtractResponse>(',
          "      { cmd: 'ai.order.extract' },",
          '      { text, market_id: `${marketId}`, trace_id: traceId },',
          '    )',
          '    .pipe(timeout(AI_RPC_TIMEOUT_MS)),',
          ');',
        ].join('\n'),
      ],
      [
        "AI bo'lmagan client.send tegilmaydi",
        "this.orderClient.send({ cmd: 'order.find_by_id' }, { id })",
      ],
    ])('%s → toza', (_name, snippet) => {
      expect(checkSource(snippet)).toEqual([]);
    });

    it("qator raqami izohlar olib tashlangandan keyin ham to'g'ri", () => {
      const src = [
        '/**',
        ' * izoh',
        ' */',
        "rmqSend(c, { cmd: 'ai.x' }, p);",
      ].join('\n');
      expect(checkSource(src)).toEqual([
        expect.objectContaining({ line: 4, rule: 'rmqSend-retries' }),
      ]);
    });
  });

  describe('repo skaneri', () => {
    const files = listAppSources();

    it("skaner bo'sh emas (glob jimgina hech narsa topmay qolmasin)", () => {
      expect(files.length).toBeGreaterThan(100);
      const rmqSendCalls = files.reduce(
        (sum, f) =>
          sum +
          findCalls(stripComments(readFileSync(f, 'utf8')), RMQ_SEND_RE).length,
        0,
      );
      // parser haqiqiy kodda ishlayotganini isbotlaydi
      expect(rmqSendCalls).toBeGreaterThan(20);
    });

    it("apps/* dagi hech bir AI RPC'si qayta yuborilmaydi va timeout'siz emas", () => {
      const violations = files.flatMap((f) =>
        checkSource(readFileSync(f, 'utf8')).map(
          (v) => `${relative(REPO_ROOT, f)}:${v.line} [${v.rule}] ${v.detail}`,
        ),
      );
      expect(violations).toEqual([]);
    });
  });
});
