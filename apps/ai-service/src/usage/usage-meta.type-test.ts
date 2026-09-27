import type { ClaudeService, ClaudeUsageRecord } from '@app/common';
import type { AiUsageService } from './ai-usage.service';
import type { ClaudeUsageMeta } from './usage-meta';

/**
 * KOMPILYATSIYA TESTI (lYVuADRE #5/#16) — jest EMAS.
 *
 * `npx tsc --noEmit -p apps/ai-service/tsconfig.app.json` (CI "TypeScript
 * check") shu faylni tekshiradi. Har `@ts-expect-error` ostidagi qator
 * HAQIQATAN xato berishi SHART — aks holda tsc TS2578 ("unused
 * @ts-expect-error") bilan yiqiladi. Ya'ni kimdir `ClaudeUsageMeta` ni
 * optional qilsa yoki meta'siz chaqiruvga yo'l ochsa, CI qizaradi.
 *
 * ⚠️ Funksiya HECH QACHON chaqirilmaydi — faqat tiplar tekshiriladi.
 */
export function usageMetaTypeTests(
  claude: ClaudeService,
  usage: AiUsageService,
): void {
  const fullMeta: ClaudeUsageMeta = {
    feature: 'order_extract_multi',
    requestArea: 'order',
    marketId: '1',
    userId: '2',
    traceId: 'trace',
    draftId: '00000000-0000-4000-8000-000000000000',
  };

  // Nazorat: to'liq meta kompilyatsiya bo'ladi (test soxta emas).
  void claude.extractJson({
    system: 's',
    userText: 't',
    schema: {},
    meta: fullMeta,
  });

  // 1) meta umuman yo'q — kompilyatsiya xatosi.
  // @ts-expect-error — `meta` required (ExtractJsonOptions).
  void claude.extractJson({ system: 's', userText: 't', schema: {} });

  // 2) marketId'siz meta — kompilyatsiya xatosi (qiymat null bo'lishi
  //    mumkin, lekin kalitni UNUTIB bo'lmaydi).
  const metaWithoutMarket = {
    feature: 'order_extract_multi',
    requestArea: 'order',
    userId: '2',
    traceId: 'trace',
    draftId: null,
  } as const;
  void claude.extractJson({
    system: 's',
    userText: 't',
    schema: {},
    // @ts-expect-error — `marketId` required (ClaudeUsageMeta).
    meta: metaWithoutMarket,
  });

  // 3) userId'siz xarajat yozuvi — kompilyatsiya xatosi.
  const fullRecord: ClaudeUsageRecord = {
    ...fullMeta,
    model: 'claude-sonnet-5',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    steps: 1,
    stopReason: 'end_turn',
    outcome: 'ok',
    inputChars: 1,
    inputSha256: '0'.repeat(64),
    imageCount: 0,
  };
  usage.record(fullRecord);

  const recordWithoutUser = {
    feature: 'order_extract_multi',
    requestArea: 'order',
    marketId: '1',
    traceId: 'trace',
    draftId: null,
    model: 'claude-sonnet-5',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    steps: 1,
    stopReason: null,
    outcome: 'ok',
    inputChars: 1,
    inputSha256: '0'.repeat(64),
    imageCount: 0,
  } as const;
  // @ts-expect-error — `userId` required (ClaudeUsageRecord extends ClaudeUsageMeta).
  usage.record(recordWithoutUser);
}
