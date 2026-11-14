/**
 * P2 — model matritsasi: buyurtma ekstraksiyasi eval'ini Message Batches API
 * orqali (−50% narx) bir nechta model/effort sozlamasida yurgizish.
 *
 * ⚠️ PULLI. `--submit` faqat `--yes` va ANTHROPIC_API_KEY bilan; avval
 * `--plan` (bepul, oflayn, tarmoqsiz) kutilgan narxni ko'rsatadi. Budjet
 * ega tomonidan tasdiqlanmaguncha `--submit` YURGIZILMAYDI.
 *
 * So'rov tanasi QO'LDA YASALMAYDI: har fixture uchun haqiqiy
 * `OrderExtractService.extract()` soxta mijoz bilan yurgiziladi va u
 * Anthropic'ga yuboradigan tana (system + kesh, sxema, maskalangan matn,
 * max_tokens, effort) aynan ushlanadi; faqat `model` va `effort`
 * sozlamadan olinadi. Natija: har sozlama uchun `recorded/<id>.json`
 * (EvalRecording, source 'live') — mavjud eval baholashi bilan o'lchanadi.
 *
 *   # 1) Reja va narx (bepul):
 *   npx ts-node -r tsconfig-paths/register scripts/ai/eval-batch-matrix.ts --plan
 *   # 2) Yuborish (PULLI, ega roziligi bilan):
 *   ANTHROPIC_API_KEY=... npx ts-node -r tsconfig-paths/register \
 *     scripts/ai/eval-batch-matrix.ts --submit --yes --out=/tmp/ai-matrix
 *   # 3) Natijani yig'ish va baholash (batch tugagach, ~1 soatgacha):
 *   ANTHROPIC_API_KEY=... npx ts-node -r tsconfig-paths/register \
 *     scripts/ai/eval-batch-matrix.ts --collect --out=/tmp/ai-matrix
 *
 * Bayroqlar: --configs=a,b (sukut — hammasi), --only=fixtureId,..., --repeat=N
 * (har fixture N marta, dispersiya uchun; sukut 1).
 * Kalit qiymati hech qayerga yozilmaydi; fixturalar sintetik (PII yo'q).
 */
import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeService } from '@app/common';
import {
  SCORED_FIELDS,
  buildReplayService,
  extractFixture,
  loadFixtures,
  scoreFixture,
  type EvalFixture,
  type EvalRecording,
  type FieldTally,
  type ScoredField,
  ReplayAnthropicClient,
} from '../../apps/ai-service/test/eval/order-extract-eval';
import { OrderExtractService } from '../../apps/ai-service/src/order-extract/order-extract.service';
import { ORDER_EXTRACT_PROMPT_VERSION } from '../../apps/ai-service/src/prompts/order-extract.prompt';
import {
  computeCostUsd,
  priceFor,
  cacheReadMultiplierFor,
  supportsEffort,
} from '../../apps/ai-service/src/usage/ai-pricing';

type Effort = 'low' | 'medium' | 'high';

export interface MatrixConfig {
  id: string;
  model: string;
  effort: Effort;
  /** Reja uchun kutilgan chiqish tokeni (thinking + JSON), bitta so'rovga. */
  expectedOutputTokens: number;
}

/**
 * Matritsa (brif P2): prod baseline, Sonnet 5.5 low/medium/high, Opus 5.5
 * low, Haiku 5.5 low. Baseline modeli — AI_ORDER_MODEL (prod qiymati),
 * bo'lmasa claude-sonnet-5.
 */
export function matrix(baselineModel: string): MatrixConfig[] {
  return [
    {
      id: 'baseline',
      model: baselineModel,
      effort: 'low',
      expectedOutputTokens: 900,
    },
    {
      id: 'sonnet55-low',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      expectedOutputTokens: 900,
    },
    {
      id: 'sonnet55-medium',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      expectedOutputTokens: 1400,
    },
    {
      id: 'sonnet55-high',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      expectedOutputTokens: 2000,
    },
    {
      id: 'opus55-low',
      model: 'claude-opus-5-5',
      effort: 'low',
      expectedOutputTokens: 900,
    },
    {
      id: 'haiku55-low',
      model: 'claude-haiku-5-5',
      effort: 'low',
      expectedOutputTokens: 900,
    },
  ];
}

/** Batch narxi — interaktiv narxning yarmi (Message Batches API). */
export const BATCH_DISCOUNT = 0.5;
/**
 * Oflayn token bahosi: belgi / 3 (o'zbek lotin + JSON, 5.x tokenizer —
 * yuqori tomonga yaxlitlangan). Aniq son: `--submit` dan oldin
 * count_tokens (bepul) bilan tekshirish mumkin.
 */
export const CHARS_PER_TOKEN = 3;

/** Haqiqiy servis yuboradigan tanani ushlaydi (tarmoq YO'Q). */
export async function captureBodies(
  fixtures: EvalFixture[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const { service, client } = buildReplayService();
  for (const f of fixtures) {
    client.bodies.length = 0;
    client.current = {
      id: f.id,
      prompt_version: ORDER_EXTRACT_PROMPT_VERSION,
      model: 'capture',
      source: 'seed',
      recorded_at: new Date(0).toISOString(),
      usage: null,
      latency_ms: null,
      response: { orders: [] },
    };
    await extractFixture(service, f);
    const body = client.bodies[0];
    if (body)
      out.set(
        f.id,
        JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
      );
  }
  return out;
}

/** Tanaga sozlama modeli va effort'i (effort'ni qabul qilmaydigan modelda — yo'q). */
export function paramsFor(
  body: Record<string, unknown>,
  c: MatrixConfig,
): Record<string, unknown> {
  const p: Record<string, unknown> = { ...body, model: c.model };
  const oc = { ...((body.output_config as Record<string, unknown>) ?? {}) };
  if (supportsEffort(c.model)) oc.effort = c.effort;
  else delete oc.effort;
  p.output_config = oc;
  return p;
}

export interface PlanRow {
  config: string;
  model: string;
  requests: number;
  inputTokens: number;
  expectedUsd: number;
  upperUsd: number;
}

/** Kutilgan va yuqori chegara narxi (batch, keshsiz — yuqori tomonga). */
export function plan(
  bodies: Map<string, Record<string, unknown>>,
  configs: MatrixConfig[],
  repeat: number,
): PlanRow[] {
  const inputTokensOf = (b: Record<string, unknown>) =>
    Math.ceil(
      JSON.stringify({
        system: b.system,
        messages: b.messages,
        output_config: b.output_config,
      }).length / CHARS_PER_TOKEN,
    );
  return configs.map((c) => {
    let input = 0;
    let expected = 0;
    let upper = 0;
    for (const b of bodies.values()) {
      const inTok = inputTokensOf(b);
      const maxTok = Number(b.max_tokens) || 4000;
      const usage = (out: number) =>
        computeCostUsd({
          model: c.model,
          inputTokens: inTok,
          outputTokens: out,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        });
      input += inTok;
      expected += usage(Math.min(c.expectedOutputTokens, maxTok));
      // Retry (kesilganda 2× max_tokens) ham hisobga — yuqori chegara.
      upper += usage(maxTok) + usage(maxTok * 2);
    }
    return {
      config: c.id,
      model: c.model,
      requests: bodies.size * repeat,
      inputTokens: input * repeat,
      expectedUsd: expected * repeat * BATCH_DISCOUNT,
      upperUsd: upper * repeat * BATCH_DISCOUNT,
    };
  });
}

function arg(name: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function selected(): {
  fixtures: EvalFixture[];
  configs: MatrixConfig[];
  repeat: number;
} {
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const fixtures = loadFixtures().filter((f) => !only || only.includes(f.id));
  const baseline =
    (process.env.AI_ORDER_MODEL ?? '').trim() || 'claude-sonnet-5';
  const want = arg('configs')?.split(',').filter(Boolean) ?? null;
  const configs = matrix(baseline).filter((c) => !want || want.includes(c.id));
  const repeat = Math.max(1, Math.min(5, Number(arg('repeat') ?? 1) || 1));
  return { fixtures, configs, repeat };
}

function usd(x: number): string {
  return `$${x.toFixed(2)}`;
}

async function runPlan(): Promise<number> {
  const { fixtures, configs, repeat } = selected();
  const bodies = await captureBodies(fixtures);
  const rows = plan(bodies, configs, repeat);
  console.log(
    `Reja: ${fixtures.length} fixture × ${configs.length} sozlama × ${repeat} takror, ` +
      `prompt ${ORDER_EXTRACT_PROMPT_VERSION}, Batch (−${BATCH_DISCOUNT * 100}%).`,
  );
  for (const r of rows) {
    const p = priceFor(r.model);
    console.log(
      `  ${r.config.padEnd(16)} ${r.model.padEnd(20)} so'rov=${r.requests} ` +
        `kirish≈${r.inputTokens} tok ($${p.in}/$${p.out}, kesh o'qish ×${cacheReadMultiplierFor(r.model)}) ` +
        `kutilgan=${usd(r.expectedUsd)} yuqori chegara=${usd(r.upperUsd)}`,
    );
  }
  const exp = rows.reduce((a, r) => a + r.expectedUsd, 0);
  const up = rows.reduce((a, r) => a + r.upperUsd, 0);
  console.log(
    `JAMI: kutilgan ${usd(exp)}, yuqori chegara ${usd(up)} (keshsiz, retry bilan).`,
  );
  return 0;
}

interface Manifest {
  batch_id: string;
  created_at: string;
  prompt_version: string;
  configs: MatrixConfig[];
  repeat: number;
  fixtures: string[];
}

async function runSubmit(): Promise<number> {
  if (!process.argv.includes('--yes')) {
    console.error("PULLI: ega roziligi bilan --yes qo'shing (avval --plan).");
    return 2;
  }
  const out = arg('out');
  if (!out) {
    console.error('--out=<katalog> majburiy.');
    return 2;
  }
  const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!key) {
    console.error("ANTHROPIC_API_KEY yo'q.");
    return 2;
  }
  const { fixtures, configs, repeat } = selected();
  const bodies = await captureBodies(fixtures);
  const requests: Anthropic.Messages.BatchCreateParams.Request[] = [];
  for (const c of configs) {
    for (const [id, body] of bodies) {
      for (let k = 0; k < repeat; k++) {
        requests.push({
          custom_id: `${c.id}__${id}__${k}`.slice(0, 64),
          params: paramsFor(
            body,
            c,
          ) as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
        });
      }
    }
  }
  const client = new Anthropic({ apiKey: key });
  const batch = await client.messages.batches.create({ requests });
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  const manifest: Manifest = {
    batch_id: batch.id,
    created_at: new Date().toISOString(),
    prompt_version: ORDER_EXTRACT_PROMPT_VERSION,
    configs,
    repeat,
    fixtures: [...bodies.keys()],
  };
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(
    `batch ${batch.id}: ${requests.length} so'rov yuborildi → ${dir}/manifest.json`,
  );
  return 0;
}

async function runCollect(): Promise<number> {
  const out = arg('out');
  const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!out || !key) {
    console.error('--out va ANTHROPIC_API_KEY majburiy.');
    return 2;
  }
  const dir = resolve(out);
  const file = join(dir, 'manifest.json');
  if (!existsSync(file)) {
    console.error(`manifest yo'q: ${file}`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  const client = new Anthropic({ apiKey: key });
  const batch = await client.messages.batches.retrieve(manifest.batch_id);
  if (batch.processing_status !== 'ended') {
    console.log(
      `batch ${batch.id}: ${batch.processing_status} — keyinroq qayta yurgizing.`,
    );
    return 3;
  }
  // custom_id → natija (tartib kafolatlanmagan — kalit bo'yicha).
  const results = new Map<
    string,
    Anthropic.Messages.MessageBatchIndividualResponse
  >();
  for await (const r of await client.messages.batches.results(batch.id)) {
    results.set(r.custom_id, r);
  }
  const fixtures = loadFixtures().filter((f) =>
    manifest.fixtures.includes(f.id),
  );
  const report: Record<string, unknown> = {};
  for (const c of manifest.configs) {
    const tallies = {} as Record<ScoredField, FieldTally>;
    for (const f of SCORED_FIELDS) tallies[f] = { correct: 0, total: 0 };
    let costUsd = 0;
    let failed = 0;
    let truncated = 0;
    const replay = new ReplayAnthropicClient();
    const config = new ConfigService({
      ANTHROPIC_API_KEY: 'replay-no-network',
    });
    const service = new OrderExtractService(
      new ClaudeService(config, () => replay, undefined, undefined),
      config,
    );
    for (const f of fixtures) {
      for (let k = 0; k < manifest.repeat; k++) {
        const r = results.get(`${c.id}__${f.id}__${k}`.slice(0, 64));
        const msg = r?.result.type === 'succeeded' ? r.result.message : null;
        if (msg) {
          const u = msg.usage;
          costUsd +=
            computeCostUsd({
              model: c.model,
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
            }) * BATCH_DISCOUNT;
        }
        if (!msg || msg.stop_reason !== 'end_turn') {
          if (msg?.stop_reason === 'max_tokens') truncated++;
          failed++;
          scoreFixture(f, [], tallies);
          continue;
        }
        const text = msg.content.find((b) => b.type === 'text');
        let parsed: { orders: unknown[] } = { orders: [] };
        try {
          parsed = JSON.parse(
            text && text.type === 'text' ? text.text : '{}',
          ) as { orders: unknown[] };
        } catch {
          failed++;
        }
        const rec: EvalRecording = {
          id: f.id,
          prompt_version: manifest.prompt_version,
          model: c.model,
          source: 'live',
          recorded_at: new Date().toISOString(),
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cache_creation_input_tokens:
              msg.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
          },
          latency_ms: null,
          response: parsed,
        };
        const recDir = join(dir, c.id, 'recorded');
        mkdirSync(recDir, { recursive: true });
        if (k === 0)
          writeFileSync(
            join(recDir, `${f.id}.json`),
            JSON.stringify(rec, null, 2) + '\n',
          );
        replay.current = rec;
        const res = await extractFixture(service, f);
        replay.current = null;
        scoreFixture(f, res.orders, tallies);
      }
    }
    const fields = Object.fromEntries(
      SCORED_FIELDS.map((k) => [
        k,
        tallies[k].total ? tallies[k].correct / tallies[k].total : null,
      ]),
    );
    report[c.id] = {
      model: c.model,
      effort: c.effort,
      cost_usd: costUsd,
      failed,
      truncated,
      fields,
    };
    console.log(
      `${c.id.padEnd(16)} narx=${usd(costUsd)} xato=${failed} kesilgan=${truncated} ` +
        SCORED_FIELDS.map(
          (k) =>
            `${k}=${fields[k] === null ? '—' : (Number(fields[k]) * 100).toFixed(1) + '%'}`,
        ).join(' '),
    );
  }
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes('--plan')) return runPlan();
  if (process.argv.includes('--submit')) return runSubmit();
  if (process.argv.includes('--collect')) return runCollect();
  console.error('--plan | --submit --yes --out=… | --collect --out=…');
  return 2;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(
        `matrix xatosi: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(2);
    },
  );
}
