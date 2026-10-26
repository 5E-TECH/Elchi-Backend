/**
 * AI buyurtma ekstraksiyasi — EVAL (regressiya) yadrosi (J3hEDtFN #2).
 *
 * Ishlatuvchilar: `scripts/ai-eval.ts` (`npm run ai:eval`) va CI spec
 * `apps/ai-service/test/order-extract-eval.spec.ts`.
 *
 * ─── Ma'lumot ───
 * `apps/ai-service/test/fixtures/order-extract/<id>.json` — kirish + kutilgan
 * natija (SINTETIK, PII yo'q; prod to'plamidan nomzodlar
 * `scripts/ai-eval-collect.ts` bilan, maskalangan holda qo'shiladi):
 *   { id, category: string[], source: 'synthetic' | 'prod-masked', note?,
 *     input: { text },
 *     expected: { orders: [ { customer_name?, phone_number? (+998XXXXXXXXX |
 *       null), extra_number?, region_name?, district_name?, address?,
 *       items?: [{name, quantity}], total_price?, comment?, where_deliver?,
 *       is_replacement?, operator?, warnings?: [{field, reason}] } ] } }
 *   Kutilgan buyurtmada YO'Q maydon baholanmaydi.
 * `recorded/<id>.json` — modelning yozib olingan XOM javobi (`[TEL_n]` bilan):
 *   { id, prompt_version, model, source: 'seed' | 'live', recorded_at,
 *     usage: null | {input_tokens, output_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens}, latency_ms: null | number,
 *     response: { orders: [...] } }
 *   `seed` — kutilgan natijadan YASALGAN (haqiqiy yozuv EMAS; quvur va
 *   baholashni tekshiradi). `live` — jonli API javobi (`--live --record`).
 *
 * ─── Replay (CI, kalitsiz) ───
 * Har fixture HAQIQIY `OrderExtractService.extract()` dan o'tadi (maskPhones →
 * ClaudeService (effort/max_tokens/sxema) → unmask → sanitize); faqat
 * Anthropic mijozi soxta — yozib olingan javobni qaytaradi, tarmoq YO'Q.
 *
 * ─── Baholash ───
 * Buyurtmalar indeks bo'yicha juftlanadi (model matn tartibida qaytaradi);
 * yetishmagan buyurtmaning barcha maydonlari xato hisoblanadi.
 *  - phone_number / extra_number: `normalizeUzPhone` tengligi (null = null);
 *  - region_name: `regionAlias` (SOATO) tengligi; district_name: `normGeo`;
 *  - customer_name / operator: `lightNorm` (translit) tengligi;
 *  - address / comment: kutilgan qiymat — MAJBURIY BO'LAK (actual ichida
 *    bo'lishi shart), `null` — actual ham null;
 *  - items: (normalizeProduct(nom), son) multiset tengligi;
 *  - total_price, where_deliver, is_replacement: aynan tenglik;
 *  - warnings: kutilgan har {field, reason} actual'da bo'lishi shart; bo'sh
 *    massiv kutilsa — actual ham bo'sh.
 * Darvoza (`--ci` va spec): phone_number, total_price, district_name ≥ 95%
 * va hech bir maydon `_baseline.json` dagidan past emas.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  AI_MODEL_DEFAULTS,
  ClaudeService,
  lightNorm,
  maskPhones,
  normGeo,
  normalizeProduct,
  normalizeUzPhone,
  regionAlias,
  type AnthropicClientLike,
  type RawOrderExtraction,
} from '@app/common';
import { OrderExtractService } from '../../src/order-extract/order-extract.service';
import { ORDER_EXTRACT_PROMPT_VERSION } from '../../src/prompts/order-extract.prompt';
import { computeCostUsd } from '../../src/usage/ai-pricing';

export const EVAL_DIR = resolve(__dirname, '../fixtures/order-extract');
export const RECORDED_DIR = join(EVAL_DIR, 'recorded');
export const BASELINE_FILE = join(EVAL_DIR, '_baseline.json');

/** Karta (J3hEDtFN #1) talab qilgan toifalar — har biri kamida 4 fixture. */
export const REQUIRED_CATEGORIES = [
  'phone_format',
  'multi_order',
  'price_words',
  'district_typo_cyrillic',
  'quantity',
  'deliver_type',
  'comment_vs_address',
] as const;
export const MIN_PER_CATEGORY = 4;
export const MIN_FIXTURES = 40;

/** Qabul mezoni: shu maydonlar aniqligi ≥ 95%. */
export const GATED_FIELDS = [
  'phone_number',
  'total_price',
  'district_name',
] as const;
export const GATE_MIN_ACCURACY = 0.95;

export const SCORED_FIELDS = [
  'orders_count',
  'customer_name',
  'phone_number',
  'extra_number',
  'region_name',
  'district_name',
  'address',
  'items',
  'total_price',
  'comment',
  'where_deliver',
  'is_replacement',
  'operator',
  'warnings',
] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

export interface ExpectedOrder {
  customer_name?: string | null;
  phone_number?: string | null;
  extra_number?: string | null;
  region_name?: string | null;
  district_name?: string | null;
  address?: string | null;
  items?: { name: string; quantity: number }[];
  total_price?: number | null;
  comment?: string | null;
  where_deliver?: 'center' | 'address' | null;
  is_replacement?: boolean;
  operator?: string | null;
  warnings?: { field: string; reason: string }[];
}

export interface EvalFixture {
  id: string;
  category: string[];
  source: 'synthetic' | 'prod-masked';
  note?: string;
  input: { text: string };
  expected: { orders: ExpectedOrder[] };
}

export interface RecordedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface EvalRecording {
  id: string;
  prompt_version: string;
  model: string;
  source: 'seed' | 'live';
  recorded_at: string;
  usage: RecordedUsage | null;
  latency_ms: number | null;
  response: { orders: unknown[] };
}

export interface FieldTally {
  correct: number;
  total: number;
}

export interface FixtureResult {
  id: string;
  category: string[];
  ok: boolean;
  reason: string | null;
  failedFields: string[];
  recording: EvalRecording | null;
  stale: boolean;
}

export interface EvalReport {
  promptVersion: string;
  fixtures: number;
  fields: Record<ScoredField, FieldTally>;
  accuracy: Record<ScoredField, number | null>;
  categories: Record<string, { passed: number; total: number }>;
  results: FixtureResult[];
  staleRecordings: string[];
  seedRecordings: number;
  liveRecordings: number;
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  } | null;
  latency: { p50: number; p95: number; n: number } | null;
}

export interface Baseline {
  prompt_version: string;
  fields: Partial<Record<ScoredField, number>>;
}

// ─── Yuklash ───

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function loadFixtures(dir = EVAL_DIR): EvalFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => readJson<EvalFixture>(join(dir, f)));
}

export function loadRecordings(dir = RECORDED_DIR): Map<string, EvalRecording> {
  const out = new Map<string, EvalRecording>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const rec = readJson<EvalRecording>(join(dir, f));
    out.set(rec.id, rec);
  }
  return out;
}

export function loadBaseline(file = BASELINE_FILE): Baseline | null {
  return existsSync(file) ? readJson<Baseline>(file) : null;
}

export function saveBaseline(report: EvalReport, file = BASELINE_FILE): void {
  const fields: Partial<Record<ScoredField, number>> = {};
  for (const f of SCORED_FIELDS) {
    const a = report.accuracy[f];
    if (a !== null) fields[f] = Math.round(a * 10_000) / 10_000;
  }
  writeFileSync(
    file,
    JSON.stringify({ prompt_version: report.promptVersion, fields }, null, 2) +
      '\n',
  );
}

// ─── Seed yozuvlar (kutilgan natijadan) ───

/**
 * Kutilgan natijadan "to'g'ri model javobi" yasaydi: telefonlar maskPhones
 * bergan `[TEL_n]` tokenlariga almashtiriladi. Telefon matnda maskalanmagan
 * bo'lsa — fixture xato (throw).
 */
export function buildSeedRecording(
  fixture: EvalFixture,
  model: string = AI_MODEL_DEFAULTS.order,
): EvalRecording {
  const { tokens } = maskPhones(fixture.input.text);
  const tokenOf = new Map<string, string>();
  for (const [token, e164] of tokens) tokenOf.set(e164, token);
  const tok = (phone: string | null | undefined): string | null => {
    if (!phone) return null;
    const t = tokenOf.get(phone);
    if (!t) {
      throw new Error(
        `fixture ${fixture.id}: ${phone} matnda [TEL_n] bilan maskalanmadi`,
      );
    }
    return t;
  };
  const orders = fixture.expected.orders.map(
    (e): RawOrderExtraction => ({
      customer_name: e.customer_name ?? null,
      phone_number: tok(e.phone_number),
      extra_number: tok(e.extra_number),
      region_name: e.region_name ?? null,
      district_name: e.district_name ?? null,
      address: e.address ?? null,
      full_address: null,
      items: (e.items ?? []).map((it) => ({ ...it })),
      total_price: e.total_price ?? null,
      comment: e.comment ?? null,
      where_deliver: e.where_deliver ?? null,
      is_replacement: e.is_replacement ?? false,
      operator: e.operator ?? null,
      warnings: (e.warnings ?? []) as RawOrderExtraction['warnings'],
    }),
  );
  return {
    id: fixture.id,
    prompt_version: ORDER_EXTRACT_PROMPT_VERSION,
    model,
    source: 'seed',
    recorded_at: new Date(0).toISOString(),
    usage: null,
    latency_ms: null,
    response: { orders },
  };
}

// ─── Baholash ───

const loose = (s: unknown): string =>
  typeof s === 'string' ? lightNorm(s).toLowerCase() : '';

function eqNullable(
  expected: unknown,
  actual: unknown,
  cmp: (e: string, a: string) => boolean,
): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  return cmp(expected, actual);
}

function itemsMultiset(items: { name: string; quantity: number }[]): string {
  return items
    .map((it) => `${normalizeProduct(it.name)}×${it.quantity}`)
    .sort()
    .join('|');
}

/** Bitta maydon to'g'rimi (kutilgan qiymat berilgan bo'lsa). */
export function fieldMatches(
  field: Exclude<ScoredField, 'orders_count'>,
  expected: ExpectedOrder,
  actual: RawOrderExtraction | undefined,
): boolean {
  if (!actual) return false;
  switch (field) {
    case 'phone_number':
    case 'extra_number':
      return eqNullable(
        expected[field],
        actual[field],
        (e, a) => normalizeUzPhone(a) === e,
      );
    case 'region_name':
      return eqNullable(
        expected.region_name,
        actual.region_name,
        (e, a) => regionAlias(a) !== null && regionAlias(a) === regionAlias(e),
      );
    case 'district_name':
      return eqNullable(
        expected.district_name,
        actual.district_name,
        (e, a) => normGeo(a) === normGeo(e),
      );
    case 'customer_name':
    case 'operator':
      return eqNullable(expected[field], actual[field], (e, a) => {
        return loose(a) === loose(e);
      });
    case 'address':
    case 'comment':
      return eqNullable(expected[field], actual[field], (e, a) =>
        loose(a).includes(loose(e)),
      );
    case 'items':
      return (
        itemsMultiset(actual.items) === itemsMultiset(expected.items ?? [])
      );
    case 'total_price':
      return actual.total_price === expected.total_price;
    case 'where_deliver':
      return actual.where_deliver === expected.where_deliver;
    case 'is_replacement':
      return actual.is_replacement === expected.is_replacement;
    case 'warnings': {
      const exp = expected.warnings ?? [];
      const act = actual.warnings ?? [];
      if (exp.length === 0) return act.length === 0;
      return exp.every((w) =>
        act.some((x) => x.field === w.field && x.reason === w.reason),
      );
    }
  }
}

function emptyTallies(): Record<ScoredField, FieldTally> {
  const out = {} as Record<ScoredField, FieldTally>;
  for (const f of SCORED_FIELDS) out[f] = { correct: 0, total: 0 };
  return out;
}

/** Bitta fixture natijasini hisoblagichlarga qo'shadi; xato maydonlar ro'yxati. */
export function scoreFixture(
  fixture: EvalFixture,
  actual: RawOrderExtraction[],
  tallies: Record<ScoredField, FieldTally>,
): string[] {
  const failed: string[] = [];
  const expected = fixture.expected.orders;
  tallies.orders_count.total += 1;
  if (actual.length === expected.length) tallies.orders_count.correct += 1;
  else failed.push(`orders_count(${actual.length}≠${expected.length})`);
  expected.forEach((exp, i) => {
    for (const field of SCORED_FIELDS) {
      if (field === 'orders_count') continue;
      if (field !== 'warnings' && !(field in exp)) continue;
      if (field === 'warnings' && exp.warnings === undefined) continue;
      tallies[field].total += 1;
      if (fieldMatches(field, exp, actual[i])) {
        tallies[field].correct += 1;
      } else {
        failed.push(expected.length > 1 ? `${field}[${i}]` : field);
      }
    }
  });
  return failed;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

// ─── Replay ───

/**
 * Soxta Anthropic mijozi: `current` yozuvini qaytaradi. Tarmoqqa HECH QACHON
 * chiqmaydi; yozuv yo'q bo'lsa throw (ClaudeService uni `ai_error` qiladi).
 */
export class ReplayAnthropicClient implements AnthropicClientLike {
  current: EvalRecording | null = null;
  readonly bodies: Record<string, unknown>[] = [];
  readonly messages = {
    create: (body: Record<string, unknown>): Promise<unknown> => {
      this.bodies.push(body);
      const rec = this.current;
      if (!rec) {
        return Promise.reject(new Error('replay: yozib olingan javob yo‘q'));
      }
      return Promise.resolve({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(rec.response) }],
        usage: rec.usage ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
    },
  };
}

export interface ReplayDeps {
  service: OrderExtractService;
  client: ReplayAnthropicClient;
}

export function buildReplayService(): ReplayDeps {
  const client = new ReplayAnthropicClient();
  const config = new ConfigService({
    ANTHROPIC_API_KEY: 'replay-no-network',
  });
  const claude = new ClaudeService(config, () => client, undefined, undefined);
  return { service: new OrderExtractService(claude, config), client };
}

/** Real (jonli) yoki replay servis bilan bitta fixture'ni yurgizadi. */
export async function extractFixture(
  service: OrderExtractService,
  fixture: EvalFixture,
): Promise<{
  ok: boolean;
  reason: string | null;
  orders: RawOrderExtraction[];
}> {
  const res = await service.extract(
    {
      text: fixture.input.text,
      market_id: '37',
      requester: { id: '0', roles: [] },
      trace_id: null,
      draft_id: randomUUID(),
      deadline_at: Date.now() + 58_000,
    },
    Date.now() + 58_000,
  );
  return res.ok
    ? { ok: true, reason: null, orders: res.orders }
    : { ok: false, reason: res.reason, orders: [] };
}

export function summarize(
  fixtures: EvalFixture[],
  results: FixtureResult[],
  tallies: Record<ScoredField, FieldTally>,
  usageRecords: { model: string; usage: RecordedUsage }[],
  latencies: number[],
): EvalReport {
  const accuracy = {} as Record<ScoredField, number | null>;
  for (const f of SCORED_FIELDS) {
    const t = tallies[f];
    accuracy[f] = t.total === 0 ? null : t.correct / t.total;
  }
  const categories: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    for (const c of r.category) {
      const entry = (categories[c] ??= { passed: 0, total: 0 });
      entry.total += 1;
      if (r.ok) entry.passed += 1;
    }
  }
  const usage =
    usageRecords.length === 0
      ? null
      : usageRecords.reduce(
          (acc, { model, usage: u }) => ({
            calls: acc.calls + 1,
            inputTokens: acc.inputTokens + u.input_tokens,
            outputTokens: acc.outputTokens + u.output_tokens,
            cacheWriteTokens:
              acc.cacheWriteTokens + u.cache_creation_input_tokens,
            cacheReadTokens: acc.cacheReadTokens + u.cache_read_input_tokens,
            costUsd:
              acc.costUsd +
              computeCostUsd({
                model,
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                cacheCreationTokens: u.cache_creation_input_tokens,
                cacheReadTokens: u.cache_read_input_tokens,
              }),
          }),
          {
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
          },
        );
  return {
    promptVersion: ORDER_EXTRACT_PROMPT_VERSION,
    fixtures: fixtures.length,
    fields: tallies,
    accuracy,
    categories,
    results,
    staleRecordings: results.filter((r) => r.stale).map((r) => r.id),
    seedRecordings: results.filter((r) => r.recording?.source === 'seed')
      .length,
    liveRecordings: results.filter((r) => r.recording?.source === 'live')
      .length,
    usage,
    latency:
      latencies.length === 0
        ? null
        : {
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            n: latencies.length,
          },
  };
}

/** CI replay: har fixture yozib olingan javob bilan haqiqiy quvurdan o'tadi. */
export async function runReplay(
  opts: { only?: Set<string> | null; deps?: ReplayDeps } = {},
): Promise<EvalReport> {
  const fixtures = loadFixtures().filter(
    (f) => !opts.only || opts.only.has(f.id),
  );
  const recordings = loadRecordings();
  const { service, client } = opts.deps ?? buildReplayService();
  const tallies = emptyTallies();
  const results: FixtureResult[] = [];
  const usageRecords: { model: string; usage: RecordedUsage }[] = [];
  const latencies: number[] = [];
  for (const fixture of fixtures) {
    const rec = recordings.get(fixture.id) ?? null;
    client.current = rec;
    const r = rec
      ? await extractFixture(service, fixture)
      : { ok: false, reason: 'no_recording', orders: [] };
    client.current = null;
    const failedFields = scoreFixture(fixture, r.orders, tallies);
    if (!r.ok) failedFields.unshift(`extract:${r.reason}`);
    if (rec?.usage) usageRecords.push({ model: rec.model, usage: rec.usage });
    if (typeof rec?.latency_ms === 'number') latencies.push(rec.latency_ms);
    results.push({
      id: fixture.id,
      category: fixture.category,
      ok: r.ok && failedFields.length === 0,
      reason: r.reason,
      failedFields,
      recording: rec,
      stale: !!rec && rec.prompt_version !== ORDER_EXTRACT_PROMPT_VERSION,
    });
  }
  return summarize(fixtures, results, tallies, usageRecords, latencies);
}

/** Darvoza xatolari (bo'sh — o'tdi). */
export function gateFailures(
  report: EvalReport,
  baseline: Baseline | null,
): string[] {
  const out: string[] = [];
  if (report.fixtures < MIN_FIXTURES) {
    out.push(`fixtures ${report.fixtures} < ${MIN_FIXTURES}`);
  }
  for (const c of REQUIRED_CATEGORIES) {
    const n = report.categories[c]?.total ?? 0;
    if (n < MIN_PER_CATEGORY)
      out.push(`category ${c}: ${n} < ${MIN_PER_CATEGORY}`);
  }
  for (const f of GATED_FIELDS) {
    const a = report.accuracy[f];
    if (a === null || a < GATE_MIN_ACCURACY) {
      out.push(
        `${f} accuracy ${formatPct(a)} < ${formatPct(GATE_MIN_ACCURACY)}`,
      );
    }
  }
  if (baseline) {
    for (const f of SCORED_FIELDS) {
      const base = baseline.fields[f];
      const a = report.accuracy[f];
      if (typeof base === 'number' && a !== null && a + 1e-9 < base) {
        out.push(`${f} ${formatPct(a)} < baseline ${formatPct(base)}`);
      }
    }
  }
  return out;
}

export function formatPct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

/** Odam o'qiydigan hisobot (konsol). */
export function formatReport(
  report: EvalReport,
  baseline: Baseline | null,
): string {
  const lines: string[] = [];
  lines.push(
    `Prompt ${report.promptVersion} — fixture=${report.fixtures} ` +
      `(seed=${report.seedRecordings}, live=${report.liveRecordings})`,
  );
  lines.push('');
  lines.push("Maydon            Aniqlik   To'g'ri/Jami  Baseline");
  for (const f of SCORED_FIELDS) {
    const t = report.fields[f];
    const base = baseline?.fields[f];
    lines.push(
      `${f.padEnd(18)}${formatPct(report.accuracy[f]).padStart(7)}   ` +
        `${`${t.correct}/${t.total}`.padStart(11)}  ${
          typeof base === 'number' ? formatPct(base) : '-'
        }`,
    );
  }
  lines.push('');
  lines.push("Toifa                    O'tdi/Jami");
  for (const [c, v] of Object.entries(report.categories).sort()) {
    lines.push(`${c.padEnd(25)}${v.passed}/${v.total}`);
  }
  const failed = report.results.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push('');
    lines.push("Yiqilgan fixture'lar:");
    for (const r of failed)
      lines.push(`  x ${r.id}: ${r.failedFields.join(', ')}`);
  }
  if (report.staleRecordings.length > 0) {
    lines.push('');
    lines.push(
      `OGOHLANTIRISH: ${report.staleRecordings.length} ta yozuv boshqa prompt ` +
        `versiyasiniki — jonli qayta yozish kerak (ega roziligi bilan: ` +
        `npm run ai:eval -- --live --yes --record).`,
    );
  }
  if (report.seedRecordings > 0) {
    lines.push('');
    lines.push(
      `ESLATMA: ${report.seedRecordings} ta yozuv 'seed' (kutilgan natijadan ` +
        `yasalgan, haqiqiy model javobi EMAS) — quvur va baholashni tekshiradi; ` +
        `model aniqligi faqat 'live' yozuvlarda o'lchanadi.`,
    );
  }
  lines.push('');
  if (report.usage) {
    const u = report.usage;
    lines.push(
      `Token/narx (yozuvlar bo'yicha): calls=${u.calls} in=${u.inputTokens} ` +
        `out=${u.outputTokens} cache_write=${u.cacheWriteTokens} ` +
        `cache_read=${u.cacheReadTokens} cost=$${u.costUsd.toFixed(4)} ` +
        `(o'rtacha $${(u.costUsd / Math.max(1, u.calls)).toFixed(5)}/chaqiruv)`,
    );
  } else {
    lines.push("Token/narx: n/a (live yozuv yo'q)");
  }
  lines.push(
    report.latency
      ? `Latency: p50=${report.latency.p50} ms p95=${report.latency.p95} ms (n=${report.latency.n})`
      : "Latency: n/a (live yozuv yo'q)",
  );
  return lines.join('\n');
}
