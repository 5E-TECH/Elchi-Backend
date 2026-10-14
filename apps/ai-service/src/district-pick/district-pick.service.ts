import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_DISTRICT_MAX_ITEMS,
  AI_DISTRICT_POOL_MAX,
  AI_MODEL_DEFAULTS,
  ClaudeService,
  type AiDistrictPickRequest,
  type AiDistrictPickResponse,
} from '@app/common';
import {
  DISTRICT_PICK_SYSTEM,
  buildDistrictPickUserText,
} from '../prompts/district-pick.prompt';
import { DISTRICT_PICK_SCHEMA } from '../prompts/district-pick.schema';

/**
 * Javob faqat `{picks:[{item_index, choice}]}`. BeePostda 64 edi — partiya
 * (≤10 item) uchun 256; kesilsa ClaudeService BIR marta 2× bilan qayta
 * urinadi, baribir kesilsa `{ok:false, reason:'truncated'}` (TC11).
 */
export const DISTRICT_PICK_MAX_TOKENS = 256;

/**
 * `ai.district.pick` (5Z1ZvvzE) — arzon model (AI_CLASSIFY_MODEL),
 * bitta preview — bitta chaqiruv, feature `order_district`.
 *
 * ⚠️ Bu servis faqat javob SHAKLINI tozalaydi. Diapazon, viloyat qulfi va
 * SOATO darvozasi order-service'da (`district-llm-fallback.ts`) — ID faqat
 * o'sha yerda `pool[choice-1]` dan olinadi.
 */
@Injectable()
export class DistrictPickService {
  constructor(
    private readonly claude: ClaudeService,
    private readonly config: ConfigService,
  ) {}

  private classifyModel(): string {
    const raw = this.config.get<unknown>('AI_CLASSIFY_MODEL');
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value || AI_MODEL_DEFAULTS.classify;
  }

  async pick(
    req: AiDistrictPickRequest,
    deadlineAt?: number,
  ): Promise<AiDistrictPickResponse> {
    const items = (Array.isArray(req?.items) ? req.items : [])
      .filter(
        (it) =>
          Array.isArray(it?.pool) &&
          it.pool.length > 0 &&
          it.pool.length <= AI_DISTRICT_POOL_MAX &&
          typeof it.place_text === 'string' &&
          it.place_text.trim() !== '',
      )
      .slice(0, AI_DISTRICT_MAX_ITEMS);
    // Tanlanadigan narsa yo'q — pulli chaqiruvning ma'nosi yo'q.
    if (items.length === 0) return { ok: true, picks: [] };

    const r = await this.claude.extractJson<{ picks: unknown }>({
      system: DISTRICT_PICK_SYSTEM,
      userText: buildDistrictPickUserText({ ...req, items }),
      schema: DISTRICT_PICK_SCHEMA,
      model: this.classifyModel(),
      maxTokens: DISTRICT_PICK_MAX_TOKENS,
      deadlineAt,
      meta: {
        feature: 'order_district',
        requestArea: 'order',
        marketId: req.market_id ?? null,
        userId: req.requester?.id ?? null,
        traceId: req.trace_id ?? null,
        draftId: req.draft_id ?? null,
      },
    });

    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, picks: sanitizePicks(r.data?.picks) };
  }
}

/** Faqat butun sonli `{item_index, choice}`; begona kalitlar tashlanadi. */
function sanitizePicks(
  value: unknown,
): { item_index: number; choice: number }[] {
  if (!Array.isArray(value)) return [];
  const picks: { item_index: number; choice: number }[] = [];
  for (const p of value) {
    if (p === null || typeof p !== 'object') continue;
    const { item_index, choice } = p as Record<string, unknown>;
    if (
      typeof item_index === 'number' &&
      Number.isInteger(item_index) &&
      typeof choice === 'number' &&
      Number.isInteger(choice)
    ) {
      picks.push({ item_index, choice });
    }
  }
  return picks;
}
