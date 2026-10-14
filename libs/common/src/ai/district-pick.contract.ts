import type { AiParseReason } from './claude.types';
import type { AiRequester } from './order-extract.contract';

/**
 * `ai.district.pick` RMQ kontrakti (order-service → ai-service, 5Z1ZvvzE) —
 * deterministik rezolver (`logistics.district.resolve_by_text`) hal qila
 * olmagan tumanni arzon modeldan INDEKS bilan so'rash.
 *
 * ⚠️ Modelga ID KO'RSATILMAYDI (Elchi ID'lari bigint — "ishonarli" soxta ID
 * boshqa haqiqiy tumanga tushib ketardi): faqat 1-asosli `index`, viloyat va
 * tuman NOMI. `district_id` order-service KOD tomonda `pool[choice-1]` dan,
 * diapazon + viloyat qulfi + SOATO darvozasidan keyin olinadi.
 * `choice = 0` — "ishonchim komil emas" (noto'g'ri tanlashdan YAXSHIROQ).
 */
export interface AiDistrictPoolEntry {
  /** 1-asosli. */
  index: number;
  region_name: string;
  district_name: string;
}

export interface AiDistrictPickItem {
  /** Preview partiyasidagi buyurtma o'rni. */
  item_index: number;
  /** Matndagi joy: district_name / address / full_address (yozilganicha). */
  place_text: string;
  /** AI ajratgan viloyat matni (bo'lsa). */
  region_name: string | null;
  pool: AiDistrictPoolEntry[];
}

export interface AiDistrictPickRequest {
  market_id: string;
  requester: AiRequester;
  trace_id: string | null;
  draft_id: string | null;
  /** Umumiy muddat (epoch ms). */
  deadline_at: number;
  items: AiDistrictPickItem[];
}

export type AiDistrictPickResponse =
  | { ok: true; picks: { item_index: number; choice: number }[] }
  | { ok: false; reason: AiParseReason };

/**
 * Viloyat noaniq bo'lganda shortlist hajmi (5Z1ZvvzE #2): BeePostdagi top-30
 * EMAS — to'g'ri tuman past ball bilan ro'yxatdan tushib qolmasin (181 tumanli
 * bazada kamida 40, TC7).
 */
export const AI_DISTRICT_SHORTLIST_SIZE = 45;
/** Bitta chaqiruvdagi pool chegarasi (eng katta viloyat — 18 tuman). */
export const AI_DISTRICT_POOL_MAX = 50;
/** Bitta preview partiyasidan LLM'ga ko'pi bilan shuncha buyurtma. */
export const AI_DISTRICT_MAX_ITEMS = 10;
