import {
  AI_CONFIG_COMMIT_DEADLINE_MS,
  startAiConfigWindow,
} from './ai-config-deadline';

describe('ai-config sent_at oynalari', () => {
  const T = 1_800_000_000_000;
  it('start ≤ 2 s; eski, kelajak, noto‘g‘ri → rad', () => {
    expect(startAiConfigWindow(T - 2000, T).ok).toBe(true);
    expect(startAiConfigWindow(T - 2001, T).ok).toBe(false);
    expect(startAiConfigWindow(T + 5000, T).ok).toBe(false);
    expect(startAiConfigWindow('1', T).ok).toBe(false);
    expect(startAiConfigWindow(undefined, T).ok).toBe(false);
  });
  it('verifier timeout = sent_at+5.5s gacha, ≤ 5000; commit ≤ 6.5 s', () => {
    const w = startAiConfigWindow(T, T);
    if (!w.ok) throw new Error('kutilmagan');
    expect(w.deadline.verifyTimeoutMs(T)).toBe(5000);
    expect(w.deadline.verifyTimeoutMs(T + 1000)).toBe(4500);
    expect(w.deadline.verifyTimeoutMs(T + 6000)).toBe(0);
    expect(w.deadline.canCommit(T + AI_CONFIG_COMMIT_DEADLINE_MS)).toBe(true);
    expect(w.deadline.canCommit(T + AI_CONFIG_COMMIT_DEADLINE_MS + 1)).toBe(
      false,
    );
  });
});
