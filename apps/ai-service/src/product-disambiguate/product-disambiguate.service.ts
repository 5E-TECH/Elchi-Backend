import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_MODEL_DEFAULTS,
  ClaudeService,
  type AiProductDisambiguateRequest,
  type AiProductDisambiguateResponse,
} from '@app/common';
import {
  PRODUCT_DISAMBIG_SYSTEM,
  buildProductDisambigUserText,
} from '../prompts/product-disambiguate.prompt';
import { PRODUCT_DISAMBIG_SCHEMA } from '../prompts/product-disambiguate.schema';

/** Javob faqat `{picks:[{item_index, choice}]}` — kichik byudjet yetadi. */
export const PRODUCT_DISAMBIG_MAX_TOKENS = 512;

type DisambigPick = { item_index: number; choice: number };

/**
 * `ai.product.disambiguate` (luv25zlI) — fuzzy moslash hal qila olmagan
 * mahsulot nomlarini market katalogidan tanlash. Arzon model
 * (AI_CLASSIFY_MODEL), bitta partiya — bitta chaqiruv.
 *
 * ⚠️ Model faqat 1-asosli katalog INDEKSINI qaytaradi (0 = mos yo'q).
 * `product_id` bu yerda ham, modelda ham YO'Q — order-service uni
 * `catalog[choice-1]` dan diapazon, egalik va raqam-token tekshiruvidan keyin
 * oladi. Bu servis faqat javob SHAKLINI tozalaydi.
 */
@Injectable()
export class ProductDisambiguateService {
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
    req: AiProductDisambiguateRequest,
    deadlineAt?: number,
  ): Promise<AiProductDisambiguateResponse> {
    // Tanlanadigan narsa yo'q — pulli chaqiruvning ma'nosi yo'q.
    if (
      !Array.isArray(req.items) ||
      req.items.length === 0 ||
      !Array.isArray(req.catalog) ||
      req.catalog.length === 0
    ) {
      return { ok: true, picks: [] };
    }

    const r = await this.claude.extractJson<{ picks: unknown }>({
      system: PRODUCT_DISAMBIG_SYSTEM,
      // Mahsulot nomlari market nazoratida — faqat user text'da (DATA),
      // system-prompt'ga hech qachon qo'shilmaydi.
      userText: buildProductDisambigUserText(req),
      schema: PRODUCT_DISAMBIG_SCHEMA,
      model: this.classifyModel(),
      maxTokens: PRODUCT_DISAMBIG_MAX_TOKENS,
      deadlineAt,
      meta: {
        feature: 'order_item_match',
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

/** Faqat butun sonli `{item_index, choice}` juftlari; begona kalitlar tashlanadi. */
function sanitizePicks(value: unknown): DisambigPick[] {
  if (!Array.isArray(value)) return [];
  const picks: DisambigPick[] = [];
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
