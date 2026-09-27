import type { AiParseReason } from './claude.types';
import type { AiRequester } from './order-extract.contract';

/**
 * `ai.product.disambiguate` RMQ kontrakti (order-service → ai-service, C2).
 *
 * ⚠️ Model faqat 1-asosli INDEKS tanlaydi (`choice`), `product_id` EMAS —
 * ID kodda `catalog[choice-1]` dan, diapazon/egalik tekshiruvidan keyin
 * olinadi. `choice = 0` — hech biri mos emas.
 */
export interface AiProductDisambiguateRequest {
  market_id: string;
  requester: AiRequester;
  trace_id: string | null;
  draft_id: string | null;
  /** Umumiy muddat (epoch ms). */
  deadline_at: number;
  items: { item_index: number; name: string; quantity: number }[];
  /** Marketning to'liq katalogi; `index` 1-asosli. */
  catalog: { index: number; name: string }[];
}

export type AiProductDisambiguateResponse =
  | {
      ok: true;
      /** `choice` — 1-asosli katalog indeksi; 0 = mos mahsulot yo'q. */
      picks: { item_index: number; choice: number }[];
    }
  | { ok: false; reason: AiParseReason };
