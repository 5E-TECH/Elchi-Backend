/**
 * `npm run ai:eval` — AI buyurtma ekstraksiyasi EVAL'i (J3hEDtFN #2).
 * Yadro va fayl formati: `apps/ai-service/test/eval/order-extract-eval.ts`.
 *
 * Rejimlar:
 *   (sukut)          REPLAY — yozib olingan javoblar bilan, kalitsiz, tarmoqsiz.
 *                    Har fixture HAQIQIY OrderExtractService quvuridan o'tadi.
 *   --ci             replay + darvoza: phone/narx/tuman ≥95%, hech bir maydon
 *                    baseline'dan past emas, ≥40 fixture, har toifa ≥4 → aks
 *                    holda exit 1. CI shu rejimda yuradi.
 *   --json           hisobotni JSON qilib chiqaradi.
 *   --only=a,b       faqat tanlangan fixture id'lari.
 *   --update-baseline  joriy aniqlikni `_baseline.json` ga yozadi (prompt
 *                    o'zgarishidan keyin, ataylab; faqat 'live' yozuvlar
 *                    bo'lsa — seed bo'yicha baseline ma'nosiz).
 *   --seed           `recorded/` dagi SEED yozuvlarni kutilgan natijadan qayta
 *                    yasaydi ('live' yozuvlar USTIDAN YOZILMAYDI).
 *   --live --yes [--record]
 *                    ⚠️ HAQIQIY Anthropic API (PUL SARFLANADI — har fixture
 *                    bitta chaqiruv + kesh tekshiruvi). Faqat SERVERDA va EGA
 *                    ROZILIGI bilan. `--record` — javoblarni 'live' yozuv
 *                    sifatida saqlaydi (usage + latency bilan). Bu xarajat
 *                    ai_usage_log'ga ham, kunlik shiftga ham YOZILMAYDI.
 *
 * Env (faqat --live): ANTHROPIC_API_KEY (qiymati hech qayerga chiqmaydi),
 * AI_ORDER_MODEL (ixtiyoriy).
 *
 * Exit: 0 — o'tdi; 1 — darvoza yiqildi (--ci) yoki jonli tekshiruv yiqildi;
 *       2 — sozlanmagan (kalit / --yes yo'q, noma'lum --only id).
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_MODEL_DEFAULTS,
  ClaudeService,
  defaultAnthropicClientFactory,
  type AnthropicClientLike,
  type ClaudeUsageRecord,
  type ClaudeUsageSink,
} from '../libs/common/src/ai';
import { OrderExtractService } from '../apps/ai-service/src/order-extract/order-extract.service';
import { ORDER_EXTRACT_PROMPT_VERSION } from '../apps/ai-service/src/prompts/order-extract.prompt';
import {
  RECORDED_DIR,
  buildSeedRecording,
  extractFixture,
  formatReport,
  gateFailures,
  loadBaseline,
  loadFixtures,
  loadRecordings,
  runReplay,
  saveBaseline,
  scoreFixture,
  summarize,
  SCORED_FIELDS,
  type EvalRecording,
  type FieldTally,
  type FixtureResult,
  type RecordedUsage,
  type ScoredField,
} from '../apps/ai-service/test/eval/order-extract-eval';

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

function writeRecording(rec: EvalRecording): void {
  if (!existsSync(RECORDED_DIR)) mkdirSync(RECORDED_DIR, { recursive: true });
  writeFileSync(
    join(RECORDED_DIR, `${rec.id}.json`),
    JSON.stringify(rec, null, 2) + '\n',
  );
}

function seed(only: Set<string> | null): number {
  const existing = loadRecordings();
  let written = 0;
  let kept = 0;
  for (const f of loadFixtures()) {
    if (only && !only.has(f.id)) continue;
    if (existing.get(f.id)?.source === 'live') {
      kept += 1;
      continue;
    }
    writeRecording(buildSeedRecording(f));
    written += 1;
  }
  console.log(`seed: ${written} ta yozildi, ${kept} ta 'live' yozuv saqlandi.`);
  return 0;
}

/** Haqiqiy mijozni o'raydi: oxirgi javobning xom JSON'i va usage'ini saqlaydi. */
class CapturingClient implements AnthropicClientLike {
  last: { response: unknown; usage: RecordedUsage | null } | null = null;
  constructor(private readonly inner: AnthropicClientLike) {}
  readonly messages = {
    create: async (body: unknown, opts?: { timeout?: number }) => {
      const res: unknown = await this.inner.messages.create(body, opts);
      const r = res as {
        content?: { type?: string; text?: unknown }[];
        usage?: Partial<RecordedUsage> | null;
      };
      const text = r?.content?.find((b) => b?.type === 'text')?.text;
      let parsed: unknown = null;
      try {
        parsed = typeof text === 'string' ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      this.last = {
        response: parsed,
        usage: r?.usage
          ? {
              input_tokens: r.usage.input_tokens ?? 0,
              output_tokens: r.usage.output_tokens ?? 0,
              cache_creation_input_tokens:
                r.usage.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
            }
          : null,
      };
      return res;
    },
  };
}

class CollectingSink implements ClaudeUsageSink {
  readonly records: ClaudeUsageRecord[] = [];
  record(r: ClaudeUsageRecord): void {
    this.records.push(r);
  }
}

async function live(
  argv: readonly string[],
  only: Set<string> | null,
): Promise<number> {
  if (!argv.includes('--yes')) {
    console.error(
      "Jonli eval HAQIQIY pul sarflaydi. Ega roziligi bilan --yes qo'shing.",
    );
    return 2;
  }
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY yo'q — jonli eval ishlamaydi.");
    return 2;
  }
  const record = argv.includes('--record');
  const model =
    (process.env.AI_ORDER_MODEL ?? '').trim() || AI_MODEL_DEFAULTS.order;
  const config = new ConfigService({
    ANTHROPIC_API_KEY: apiKey,
    AI_ORDER_MODEL: model,
    AI_ORDER_VISION_MODEL: model,
  });
  let capturing: CapturingClient | null = null;
  const sink = new CollectingSink();
  const claude = new ClaudeService(
    config,
    (o) => (capturing = new CapturingClient(defaultAnthropicClientFactory(o))),
    sink,
    undefined,
  );
  if (!claude.isEnabled() || !capturing) {
    console.error('ClaudeService yoqilmadi (mijoz qurilmadi).');
    return 2;
  }
  const client: CapturingClient = capturing;
  const service = new OrderExtractService(claude, config);
  const fixtures = loadFixtures().filter((f) => !only || only.has(f.id));
  const tallies = {} as Record<ScoredField, FieldTally>;
  for (const f of SCORED_FIELDS) tallies[f] = { correct: 0, total: 0 };
  const results: FixtureResult[] = [];
  const usageRecords: { model: string; usage: RecordedUsage }[] = [];
  const latencies: number[] = [];
  console.log(
    `JONLI eval: prompt ${ORDER_EXTRACT_PROMPT_VERSION}, model=${model}, ` +
      `fixture=${fixtures.length}${record ? ' (yozib olinadi)' : ''}`,
  );
  for (const fixture of fixtures) {
    client.last = null;
    const before = sink.records.length;
    const started = Date.now();
    const r = await extractFixture(service, fixture);
    const latency = Date.now() - started;
    const failedFields = scoreFixture(fixture, r.orders, tallies);
    if (!r.ok) failedFields.unshift(`extract:${r.reason}`);
    for (const u of sink.records.slice(before)) {
      usageRecords.push({
        model: u.model,
        usage: {
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_creation_input_tokens: u.cacheCreationTokens,
          cache_read_input_tokens: u.cacheReadTokens,
        },
      });
    }
    latencies.push(latency);
    const captured = client.last as CapturingClient['last'];
    const rec: EvalRecording | null =
      captured && captured.response
        ? {
            id: fixture.id,
            prompt_version: ORDER_EXTRACT_PROMPT_VERSION,
            model,
            source: 'live',
            recorded_at: new Date().toISOString(),
            usage: captured.usage,
            latency_ms: latency,
            response: captured.response as { orders: unknown[] },
          }
        : null;
    if (record && rec && r.ok) writeRecording(rec);
    results.push({
      id: fixture.id,
      category: fixture.category,
      ok: r.ok && failedFields.length === 0,
      reason: r.reason,
      failedFields,
      recording: rec,
      stale: false,
    });
    console.log(
      `[${failedFields.length === 0 ? 'PASS' : 'FAIL'}] ${fixture.id} ${latency} ms` +
        (failedFields.length ? ` — ${failedFields.join(', ')}` : ''),
    );
  }

  // Kesh tekshiruvi: bir xil matn ketma-ket 2 marta — 2-chaqiruvda cache_read > 0.
  let cacheOk = true;
  if (fixtures.length > 0) {
    await extractFixture(service, fixtures[0]);
    const before = sink.records.length;
    await extractFixture(service, fixtures[0]);
    const second = sink.records.slice(before);
    cacheOk = second.some((u) => u.cacheReadTokens > 0);
    console.log(
      `[${cacheOk ? 'PASS' : 'FAIL'}] cache_hit — 2-chaqiruv cache_read=${second
        .map((u) => u.cacheReadTokens)
        .join(',')}`,
    );
  }

  const report = summarize(fixtures, results, tallies, usageRecords, latencies);
  console.log('\n' + formatReport(report, loadBaseline()));
  const gate = gateFailures(report, loadBaseline());
  return gate.length === 0 && cacheOk ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Har chaqiruvdagi `claude_usage` LOG qatorlari hisobotni ko'mmasin.
  Logger.overrideLogger(['error', 'warn']);
  const only = parseOnly(argv);
  if (only) {
    const known = new Set(loadFixtures().map((f) => f.id));
    const unknown = [...only].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(`Noma'lum --only id: ${unknown.join(', ')}`);
      return 2;
    }
  }
  if (argv.includes('--seed')) return seed(only);
  if (argv.includes('--live')) return live(argv, only);

  const report = await runReplay({ only });
  const baseline = loadBaseline();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, baseline));
  }
  if (argv.includes('--update-baseline')) {
    // Seed yozuvlar (kutilgan natijadan yasalgan) bo'yicha baseline
    // ma'nosiz (doim 100%) — faqat 'live' yozuvlar bo'lsa yoziladi.
    if (report.liveRecordings === 0) {
      console.error(
        "\n_baseline.json YANGILANMADI: 'live' yozuv yo'q (seed bo'yicha " +
          "baseline ma'nosiz). Avval: npm run ai:eval -- --live --yes --record",
      );
      return 2;
    }
    saveBaseline(report);
    console.log('\n_baseline.json yangilandi.');
  }
  if (argv.includes('--ci')) {
    const gate = gateFailures(report, baseline);
    if (gate.length > 0) {
      console.error(`\nDARVOZA YIQILDI:\n  - ${gate.join('\n  - ')}`);
      return 1;
    }
    console.log('\nDarvoza: OK');
  }
  return 0;
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
