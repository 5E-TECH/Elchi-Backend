import { Counter } from 'prom-client';

/**
 * (AI ack S7) ai-confirm ack darvozasi hodisalari — Grafana/ops:
 * `sum by (outcome, enforced) (increase(ai_confirm_ack_total[1h]))`.
 *
 * outcome:
 *  - `checks_not_acknowledged` — 409 (yoki log-only'da would_409);
 *  - `draft_required` / `draft_not_found` / `item_not_found` — 400 (would_400);
 *  - `checks_unavailable` — ai-service javob bermadi, 503 (would_503);
 *  - `snapshot_pending` — yosh draft, snapshot hali yo'q, 503 (would_503);
 *  - `fail_open_legacy` — eski (feature'dan oldingi) snapshot, `check_codes` yo'q;
 *  - `fail_open_purged` — retention snapshot'ni tozalagan;
 *  - `fail_open_snapshot_missing` — snapshot yo'q va draft eski (> 2 daqiqa)
 *    yoki eski ai-service holat bermadi.
 * enforced: `on` | `off` (`AI_ACK_CHECKS_ENFORCE`).
 * Qiymat — buyurtmalar soni (so'rovlar emas). Kardinallik qat'iy (9 × 2).
 * Global registry'ga emas — `registerMetrics(app, 'api-gateway', [...])`.
 */
export const aiConfirmAckTotal = new Counter({
  name: 'ai_confirm_ack_total',
  help: 'ai-confirm AI ack darvozasi: rad etilgan / log-only / fail-open buyurtmalar',
  labelNames: ['outcome', 'enforced'],
  registers: [],
});

export type AiAckOutcome =
  | 'checks_not_acknowledged'
  | 'draft_required'
  | 'draft_not_found'
  | 'item_not_found'
  | 'checks_unavailable'
  | 'snapshot_pending'
  | 'fail_open_legacy'
  | 'fail_open_purged'
  | 'fail_open_snapshot_missing';

export function recordAiAck(
  outcome: AiAckOutcome,
  enforced: boolean,
  count: number,
): void {
  if (!Number.isFinite(count) || count <= 0) return;
  aiConfirmAckTotal.inc({ outcome, enforced: enforced ? 'on' : 'off' }, count);
}
