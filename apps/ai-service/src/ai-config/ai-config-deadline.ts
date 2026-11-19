/**
 * `sent_at` vaqt oynalari (be-brief §6.2). Gateway va ai-service BITTA hostda
 * (bir soat) — oynalar shunga tayanadi; ajratilsa NTP talab qilinadi
 * (spec §16).
 *
 * - START: xabar `sent_at` dan ≤ 2000 ms ichida boshlansa ishlanadi
 *   (navbatda turib qolgan xabar — rad, hech narsa o'zgarmaydi).
 * - VERIFIER: Anthropic tekshiruvi `sent_at + 5500` gacha tugashi kerak.
 * - COMMIT: tranzaksiya `sent_at + 6500` gacha COMMIT bo'lmasa — rollback.
 *   Gateway RMQ timeout'i (8 s) bundan katta: ya'ni gateway 504 olsa,
 *   o'zgarish albatta saqlanmagan (AC5).
 */
export const AI_CONFIG_START_WINDOW_MS = 2000;
export const AI_CONFIG_VERIFY_DEADLINE_MS = 5500;
export const AI_CONFIG_COMMIT_DEADLINE_MS = 6500;
/** Bitta tekshiruv uchun SDK timeout'i shifti. */
export const AI_CONFIG_VERIFY_MAX_TIMEOUT_MS = 5000;

export interface AiConfigDeadline {
  sentAt: number;
  /** Verifier uchun qolgan vaqt (ms, ≤ 5000, ≥ 0). */
  verifyTimeoutMs(now?: number): number;
  /** Commit hali mumkinmi. */
  canCommit(now?: number): boolean;
}

export type AiConfigStartCheck =
  { ok: true; deadline: AiConfigDeadline } | { ok: false };

/** `sent_at` noto'g'ri yoki eskirgan bo'lsa — `{ok:false}` (AI_CONFIG_EXPIRED). */
export function startAiConfigWindow(
  sentAt: unknown,
  now: number = Date.now(),
): AiConfigStartCheck {
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) {
    return { ok: false };
  }
  const age = now - sentAt;
  // Kelajakdagi sent_at (soat sakrashi) ham shubhali — 1 s gacha bardosh.
  if (age > AI_CONFIG_START_WINDOW_MS || age < -1000) return { ok: false };
  return {
    ok: true,
    deadline: {
      sentAt,
      verifyTimeoutMs: (t = Date.now()) =>
        Math.max(
          0,
          Math.min(
            AI_CONFIG_VERIFY_MAX_TIMEOUT_MS,
            sentAt + AI_CONFIG_VERIFY_DEADLINE_MS - t,
          ),
        ),
      canCommit: (t = Date.now()) => t - sentAt <= AI_CONFIG_COMMIT_DEADLINE_MS,
    },
  };
}
