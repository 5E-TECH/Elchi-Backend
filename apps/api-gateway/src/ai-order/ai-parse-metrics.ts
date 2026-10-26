import { Histogram } from 'prom-client';

/**
 * WHMAIqyo #5 — ai-parse bosqichlari davomiyligi (Grafana/ops'da p50/p95):
 * `histogram_quantile(0.95, sum by (le, stage, source) (rate(
 *   ai_parse_stage_duration_seconds_bucket[1h])))`.
 *
 * - stage: extract (`ai.order.extract` RPC) | preview
 *   (`order.ai_resolve_preview`) | total (butun handler);
 * - source: text | image; outcome: ok | fail.
 * Label kardinalligi qat'iy (3 × 2 × 2). Global registry'ga emas —
 * `registerMetrics(app, 'api-gateway', [aiParseStageSeconds])` ulaydi.
 * Bazadagi nusxasi: `ai_order_draft.extract_ms|preview_ms|total_ms`.
 */
export const aiParseStageSeconds = new Histogram({
  name: 'ai_parse_stage_duration_seconds',
  help: 'AI buyurtma ai-parse bosqichlari davomiyligi (soniya)',
  labelNames: ['stage', 'source', 'outcome'],
  buckets: [1, 2, 4, 6, 8, 10, 12, 15, 20, 30, 40, 60, 90],
  registers: [],
});

export type AiParseStage = 'extract' | 'preview' | 'total';

export function observeAiParseStage(
  stage: AiParseStage,
  source: 'text' | 'image',
  outcome: 'ok' | 'fail',
  ms: number,
): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  aiParseStageSeconds.observe({ stage, source, outcome }, ms / 1000);
}
