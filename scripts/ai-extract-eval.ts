/**
 * AI buyurtma ekstraksiyasi — JONLI eval (yxwpN5h5 #1-#9, #12; 32fNx0Ci #1-#2).
 *
 * ⚠️ HAQIQIY PUL SARFLAYDI: har fixture Anthropic API'ga haqiqiy so'rov
 * yuboradi (16 ta chaqiruv: 14 fixture + kesh tekshiruvi uchun 2 ta).
 * FAQAT SERVERDA va EGANING ROZILIGI bilan ishga tushiring. Bu xarajat
 * ai_usage_log'ga ham, kunlik shiftga (ai_spend_counter) ham YOZILMAYDI —
 * skript ai-service'dan tashqarida, ClaudeService'ni o'zi quradi.
 *
 * ⚠️ Bu SPEC EMAS va hech qachon CI'da ishlamaydi: jest `roots` faqat apps/ va
 * libs/, fayl nomi `.spec.ts` emas. Prompt/sxemaning tuzilmaviy qulfi CI'da —
 * `apps/ai-service/src/prompts/*.spec.ts` (Claude chaqirilmaydi).
 *
 * Nima qiladi: ai-service'dagi haqiqiy yo'lni takrorlaydi — maskPhones
 * ([TEL_n]) -> ClaudeService.extractJson(ORDER_EXTRACT_SYSTEM,
 * ORDER_EXTRACT_SCHEMA, maxTokens 32000) -> unmaskPhones — va model
 * chiqishini (sanitize'dan OLDIN) fixture tekshiruvlari bilan solishtiradi.
 * Oxirida bir xil matn ketma-ket 2 marta yuboriladi: 2-chaqiruvda
 * cache_read_input_tokens > 0 bo'lishi shart (prompt keshi ishlayapti).
 *
 * Ishga tushirish (repo ildizidan, dev dependency'lar — ts-node — kerak):
 *   node -r ts-node/register -r tsconfig-paths/register scripts/ai-extract-eval.ts --dry-run
 *   ANTHROPIC_API_KEY=... node -r ts-node/register -r tsconfig-paths/register scripts/ai-extract-eval.ts --yes
 *
 * Flaglar:
 *   --dry-run      API chaqirilmaydi: fixture'lar va maskalangan matn chiqariladi (bepul).
 *   --yes          jonli rejim (pul sarflanadi) — ataylab talab qilinadi.
 *   --only=a,b     faqat tanlangan fixture id'lari (kesh tekshiruvi id'si: cache_hit).
 *
 * Env: ANTHROPIC_API_KEY (jonli rejimda majburiy; qiymati hech qayerga
 * chiqarilmaydi), AI_ORDER_MODEL (ixtiyoriy, sukut claude-sonnet-5).
 *
 * Exit: 0 — hammasi o'tdi; 1 — kamida bitta tekshiruv yiqildi;
 *       2 — sozlanmagan (kalit yo'q, --yes yo'q yoki noma'lum --only id).
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  AI_MODEL_DEFAULTS,
  ClaudeService,
  type ClaudeUsageRecord,
  type ClaudeUsageSink,
  type RawOrderExtraction,
} from '../libs/common/src/ai';
import { maskPhones, unmaskPhones } from '../libs/common/src/pii/mask-phones';
import {
  ORDER_EXTRACT_PROMPT_VERSION,
  ORDER_EXTRACT_SYSTEM,
} from '../apps/ai-service/src/prompts/order-extract.prompt';
import { ORDER_EXTRACT_SCHEMA } from '../apps/ai-service/src/prompts/order-extract.schema';
import {
  CACHE_PROBE_TEXT,
  EVAL_FIXTURES,
  GLOBAL_CHECKS,
  type EvalCheck,
  type EvalFixture,
} from './ai-extract-eval.fixtures';

/** ai-service OrderExtractService bilan bir xil byudjet (thinking ham shundan). */
const EVAL_MAX_TOKENS = 32_000;
const CACHE_PROBE_ID = 'cache_hit';

interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface CallResult {
  ok: boolean;
  reason: string | null;
  orders: RawOrderExtraction[];
  usage: UsageTotals;
  ms: number;
}

/** Har Anthropic javobining usage yozuvini yig'adi (retry urinishlari ham). */
class CollectingSink implements ClaudeUsageSink {
  readonly records: ClaudeUsageRecord[] = [];
  record(r: ClaudeUsageRecord): void {
    this.records.push(r);
  }
}

function sumUsage(records: readonly ClaudeUsageRecord[]): UsageTotals {
  return records.reduce<UsageTotals>(
    (acc, r) => ({
      calls: acc.calls + 1,
      input: acc.input + r.inputTokens,
      output: acc.output + r.outputTokens,
      cacheWrite: acc.cacheWrite + r.cacheCreationTokens,
      cacheRead: acc.cacheRead + r.cacheReadTokens,
    }),
    { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  );
}

function formatUsage(u: UsageTotals, ms: number): string {
  return (
    `${(ms / 1000).toFixed(1)}s calls=${u.calls} in=${u.input} out=${u.output} ` +
    `cache_write=${u.cacheWrite} cache_read=${u.cacheRead}`
  );
}

async function extract(
  claude: ClaudeService,
  sink: CollectingSink,
  model: string,
  text: string,
): Promise<CallResult> {
  const { masked, tokens } = maskPhones(text);
  const before = sink.records.length;
  const started = Date.now();
  const res = await claude.extractJson<{ orders?: unknown }>({
    system: ORDER_EXTRACT_SYSTEM,
    userText: masked,
    schema: ORDER_EXTRACT_SCHEMA,
    model,
    maxTokens: EVAL_MAX_TOKENS,
    meta: {
      feature: 'order_extract_multi',
      requestArea: 'other',
      marketId: null,
      userId: null,
      traceId: null,
      draftId: null,
    },
  });
  const usage = sumUsage(sink.records.slice(before));
  const ms = Date.now() - started;
  if (!res.ok) {
    return { ok: false, reason: res.reason, orders: [], usage, ms };
  }
  const data = unmaskPhones(res.data, tokens);
  if (!Array.isArray(data?.orders)) {
    return { ok: false, reason: "orders massivi yo'q", orders: [], usage, ms };
  }
  return {
    ok: true,
    reason: null,
    orders: data.orders as RawOrderExtraction[],
    usage,
    ms,
  };
}

function runChecks(
  checks: readonly EvalCheck[],
  orders: readonly RawOrderExtraction[],
): string[] {
  const failed: string[] = [];
  for (const check of checks) {
    let pass = false;
    try {
      pass = check.test(orders);
    } catch {
      pass = false;
    }
    if (!pass) failed.push(check.label);
  }
  return failed;
}

function parseOnly(argv: readonly string[]): Set<string> | null {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  return new Set(
    arg
      .slice('--only='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function dryRun(fixtures: readonly EvalFixture[], withProbe: boolean): number {
  console.log('[dry-run] Anthropic chaqirilmaydi.\n');
  for (const f of fixtures) {
    const { masked, tokens } = maskPhones(f.text);
    console.log(`- ${f.id} (${f.covers.join(', ')}) tokens=${tokens.size}`);
    console.log(`  ${masked.replace(/\n/g, '\n  ')}`);
    if (tokens.size === 0) {
      console.log('  OGOHLANTIRISH: matnda telefon maskalanmadi');
    }
  }
  if (withProbe) {
    console.log(
      `- ${CACHE_PROBE_ID} (yxwpN5h5 #12): bir xil matn 2 marta, 2-chaqiruvda cache_read > 0`,
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const only = parseOnly(argv);
  const knownIds = new Set([...EVAL_FIXTURES.map((f) => f.id), CACHE_PROBE_ID]);
  if (only) {
    const unknown = [...only].filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      console.error(
        `Noma'lum --only id: ${unknown.join(', ')}. Mavjud: ${[...knownIds].join(', ')}`,
      );
      return 2;
    }
  }
  const fixtures = EVAL_FIXTURES.filter((f) => !only || only.has(f.id));
  const withProbe = !only || only.has(CACHE_PROBE_ID);

  const model =
    (process.env.AI_ORDER_MODEL ?? '').trim() || AI_MODEL_DEFAULTS.order;
  const promptSha = createHash('sha256')
    .update(ORDER_EXTRACT_SYSTEM, 'utf8')
    .digest('hex');
  console.log(
    `Prompt ${ORDER_EXTRACT_PROMPT_VERSION} sha256=${promptSha.slice(0, 12)} ` +
      `(${ORDER_EXTRACT_SYSTEM.length} belgi), model=${model}, ` +
      `fixture=${fixtures.length}${withProbe ? ' + kesh tekshiruvi' : ''}`,
  );

  if (argv.includes('--dry-run')) return dryRun(fixtures, withProbe);

  if (!argv.includes('--yes')) {
    console.error(
      "Jonli eval HAQIQIY pul sarflaydi. Ega roziligi bilan --yes qo'shing " +
        '(yoki bepul tekshiruv uchun --dry-run).',
    );
    return 2;
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY yo'q — jonli eval ishlamaydi.");
    return 2;
  }

  const sink = new CollectingSink();
  const claude = new ClaudeService(
    new ConfigService({ ANTHROPIC_API_KEY: apiKey, AI_ORDER_MODEL: model }),
    undefined,
    sink,
    undefined,
  );
  if (!claude.isEnabled()) {
    console.error('ClaudeService yoqilmadi (mijoz qurilmadi).');
    return 2;
  }

  let failures = 0;
  const report = (
    id: string,
    covers: string,
    failed: string[],
    detail: string,
    output?: unknown,
  ): void => {
    const status = failed.length === 0 ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${id} (${covers}) ${detail}`);
    for (const label of failed) console.log(`       x ${label}`);
    if (failed.length > 0 && output !== undefined) {
      // Matnlar sintetik (PII yo'q) — tashxis uchun chiqish ko'rsatiladi.
      console.log(`       chiqish: ${JSON.stringify(output)}`);
    }
    if (failed.length > 0) failures += 1;
  };

  for (const f of fixtures) {
    const r = await extract(claude, sink, model, f.text);
    const failed = r.ok
      ? runChecks([...GLOBAL_CHECKS, ...f.checks], r.orders)
      : [`extractJson ok:false reason=${r.reason}`];
    report(
      f.id,
      f.covers.join(', '),
      failed,
      formatUsage(r.usage, r.ms),
      r.orders,
    );
  }

  if (withProbe) {
    // yxwpN5h5 #12 / cSUBv0tY #8: bir xil system + matn ketma-ket 2 marta.
    const first = await extract(claude, sink, model, CACHE_PROBE_TEXT);
    const second = await extract(claude, sink, model, CACHE_PROBE_TEXT);
    const failed: string[] = [];
    if (!first.ok) failed.push(`1-chaqiruv ok:false reason=${first.reason}`);
    if (!second.ok) failed.push(`2-chaqiruv ok:false reason=${second.reason}`);
    if (second.usage.cacheRead <= 0) {
      failed.push('2-chaqiruvda cache_read_input_tokens > 0');
    }
    report(
      CACHE_PROBE_ID,
      'yxwpN5h5 #12',
      failed,
      `1: ${formatUsage(first.usage, first.ms)} | 2: ${formatUsage(second.usage, second.ms)}`,
    );
  }

  const total = sumUsage(sink.records);
  const ran = fixtures.length + (withProbe ? 1 : 0);
  console.log(
    `\nNatija: ${ran - failures}/${ran} o'tdi. Jami usage: calls=${total.calls} ` +
      `in=${total.input} out=${total.output} cache_write=${total.cacheWrite} ` +
      `cache_read=${total.cacheRead}`,
  );
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      `Eval kutilmagan xato: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  },
);
