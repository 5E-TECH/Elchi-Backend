import type { AiAdvisorCandidate } from '@app/common';

/** Dalil qatorlari chegarasi (finance `ADVISOR_EVIDENCE_LIMIT` bilan bir xil). */
export const ADVISOR_MERGE_EVIDENCE_LIMIT = 15;

const money = (v: number): number => Math.round(v * 100) / 100;

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const time = (v: unknown): number => {
  const t = new Date(typeof v === 'string' ? v : 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

const cmpId = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * R1 (round-2 #651 B1): ochiq ogohlantirishga yangi fakt-smenalar QO'SHILADI
 * — finance nomzodida faqat shu tick smenalari bor, shuning uchun saqlangan
 * `facts`/`evidence` bilan birlashtiriladi:
 * - `shifts_count` / `total_difference` = saqlangan + FAQAT yangi faktlar
 *   (`fact_keys[].amount`) — §5.3 «ogohlantirishdagi fakt-smenalar»;
 * - `evidence.rows` — `shift_id` bo'yicha birlashma, oxirgi 15 (`closed_at`);
 * - `closed_by` — birlashma (yangilari oldin), ≤ 5;
 * - `trigger`, `last_*`, `streak_*` — eng yangi faktdan (nomzod).
 *
 * `fresh` — shu tick'da BIRINCHI marta ko'rilgan `fact_key`lar. Yangi
 * ogohlantirish ochilganda `stored` bo'sh — faqat yangi faktlar (#651-1).
 */
export function mergeR1(
  stored: { facts: unknown; evidence: unknown },
  c: AiAdvisorCandidate,
  fresh: ReadonlySet<string>,
): AiAdvisorCandidate {
  const sf = (stored.facts ?? {}) as Record<string, unknown>;
  const se = (stored.evidence ?? {}) as Record<string, unknown>;
  const freshFacts = c.fact_keys.filter((f) => fresh.has(f.fact_key));
  const count = num(sf.shifts_count) + freshFacts.length;
  const total = money(
    num(sf.total_difference) +
      freshFacts.reduce((sum, f) => sum + num(f.amount), 0),
  );

  const storedRows =
    (se.rows as Array<Record<string, unknown>> | undefined) ?? [];
  const storedIds = new Set(storedRows.map((r) => r?.shift_id));
  // Nomzoddagi qator — faqat YANGI fakt yoki allaqachon saqlangan smena
  // (round-4 #651-1: boshqa — yopilgan ogohlantirishniki — qo'shilmaydi).
  const candRows: Array<Record<string, unknown>> = [];
  const droppedRows: Array<Record<string, unknown>> = [];
  for (const r of (c.evidence.rows as
    Array<Record<string, unknown>> | undefined) ?? []) {
    if (typeof r?.shift_id !== 'string') continue;
    (fresh.has(r.shift_id) || storedIds.has(r.shift_id)
      ? candRows
      : droppedRows
    ).push(r);
  }
  const closerOf = (r: Record<string, unknown>): unknown =>
    (r.closed_by as { id?: unknown } | null | undefined)?.id;
  const keptClosers = new Set(candRows.map(closerOf));
  // Faqat tashlab yuborilgan smenalarni yopganlar — `closed_by` dan chiqadi.
  const droppedClosers = new Set(
    droppedRows.map(closerOf).filter((id) => !keptClosers.has(id)),
  );

  const rows = new Map<string, Record<string, unknown>>();
  for (const r of [...storedRows, ...candRows]) {
    if (typeof r?.shift_id === 'string') rows.set(r.shift_id, r);
  }
  const merged = [...rows.values()]
    .sort(
      (a, b) =>
        time(a.closed_at) - time(b.closed_at) ||
        cmpId(String(a.shift_id), String(b.shift_id)),
    )
    .slice(-ADVISOR_MERGE_EVIDENCE_LIMIT);

  const closedBy: Array<{ id: string; name: string | null }> = [];
  for (const ref of [
    ...((c.facts.closed_by as unknown[] | undefined) ?? []).filter(
      (x) => !droppedClosers.has((x as { id?: unknown } | null)?.id),
    ),
    ...((sf.closed_by as unknown[] | undefined) ?? []),
  ]) {
    const r = ref as { id?: unknown; name?: unknown } | null;
    if (!r || typeof r.id !== 'string') continue;
    if (closedBy.some((x) => x.id === r.id)) continue;
    closedBy.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : null,
    });
    if (closedBy.length === 5) break;
  }

  const facts: Record<string, unknown> = {
    ...c.facts,
    shifts_count: count,
    total_difference: total,
    closed_by: closedBy,
  };
  return {
    ...c,
    headline_amount:
      facts.trigger === 'single_shortage' ? num(facts.last_difference) : total,
    facts,
    evidence: {
      ...c.evidence,
      total_rows: count,
      truncated: count > ADVISOR_MERGE_EVIDENCE_LIMIT,
      rows: merged,
      totals: { count, difference: total },
    },
  };
}
