import { AI_MODEL_DEFAULTS, type AiSlot } from '@app/common';
import {
  AI_MODEL_PRICES,
  CACHE_WRITE_MULTIPLIER,
  cacheReadMultiplierFor,
  normalizeModelId,
} from '../usage/ai-pricing';
import { AI_STRONG_EXTRACTION_MODELS } from '../models/ai-model-policy';

/**
 * 6 ta AI vazifasi (slot) — spec §7.1. Ishlatiladigan model: UI tanlovi
 * (BE-2) → env → kod sukuti. BE-1 da faqat o'qiladigan blok (env/sukut).
 */
export interface AiSlotDef {
  slot: AiSlot;
  env: string;
  features: string[];
  defaultModel: string;
  needs: { image: boolean; structured: boolean; tools: boolean };
  /** Ekstraksiya — kuchli model talab qilinadi (`weak` verdikt). */
  extraction: boolean;
}

/** Yordamchining kod sukuti (assistant.service.ts bilan bir xil). */
export const AI_ASSISTANT_DEFAULT_MODEL = 'claude-sonnet-5';

export const AI_SLOT_DEFS: readonly AiSlotDef[] = [
  {
    slot: 'order',
    env: 'AI_ORDER_MODEL',
    features: ['order_extract_multi'],
    defaultModel: AI_MODEL_DEFAULTS.order,
    needs: { image: false, structured: true, tools: false },
    extraction: true,
  },
  {
    slot: 'vision',
    env: 'AI_ORDER_VISION_MODEL',
    features: ['order_extract_image'],
    defaultModel: AI_MODEL_DEFAULTS.vision,
    needs: { image: true, structured: true, tools: false },
    extraction: true,
  },
  {
    slot: 'district',
    env: 'AI_DISTRICT_MODEL',
    features: ['order_district'],
    defaultModel: AI_MODEL_DEFAULTS.district,
    needs: { image: false, structured: true, tools: false },
    extraction: false,
  },
  {
    slot: 'classify',
    env: 'AI_CLASSIFY_MODEL',
    features: ['order_item_match'],
    defaultModel: AI_MODEL_DEFAULTS.classify,
    needs: { image: false, structured: true, tools: false },
    extraction: false,
  },
  {
    slot: 'finance_vision',
    env: 'AI_FINANCE_VISION_MODEL',
    features: ['finance_balance_screenshot', 'finance_receipt_check'],
    defaultModel: AI_MODEL_DEFAULTS.vision,
    needs: { image: true, structured: true, tools: false },
    extraction: true,
  },
  {
    slot: 'assistant',
    env: 'AI_ASSISTANT_MODEL',
    features: ['assistant'],
    defaultModel: AI_ASSISTANT_DEFAULT_MODEL,
    needs: { image: false, structured: false, tools: true },
    extraction: false,
  },
];

/**
 * Narxi hali tasdiqlanmagan modellar (ega qarori 2026-11-15 (c): Sonnet 5
 * narxi hisob-faktura bilan tekshirilguncha «narx tasdiqlanmagan»).
 * ⚠️ BE-2 da `ai-pricing.ts` yonidagi alohida `AI_PRICE_CONFIRMED`
 * eksportiga ko'chadi; narx jadvaliga TEGILMAYDI.
 */
export const AI_PRICE_UNCONFIRMED: ReadonlySet<string> = new Set(['sonnet-5']);

export type AiSlotVerdict = 'ok' | 'weak' | 'unknown' | 'deprecated';

export function slotVerdict(def: AiSlotDef, model: string): AiSlotVerdict {
  const key = normalizeModelId(model);
  if (!Object.prototype.hasOwnProperty.call(AI_MODEL_PRICES, key))
    return 'unknown';
  if (def.extraction && !AI_STRONG_EXTRACTION_MODELS.has(key)) return 'weak';
  return 'ok';
}

/** UI narx bloki (USD / 1M token) — noma'lum model uchun null. */
export function slotPrice(model: string): {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
} | null {
  const key = normalizeModelId(model);
  if (!Object.prototype.hasOwnProperty.call(AI_MODEL_PRICES, key)) return null;
  const p = AI_MODEL_PRICES[key];
  return {
    input: p.in,
    output: p.out,
    cache_read: p.in * cacheReadMultiplierFor(model),
    cache_write_5m: p.in * CACHE_WRITE_MULTIPLIER,
  };
}
