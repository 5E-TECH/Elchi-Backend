/**
 * `logistics.district.resolve_by_text` shartnomasi (PLAN C7, karta AnKM7xmy).
 *
 * Erkin matndan (AI ajratgan yoki operator yozgan) viloyat + tumanni
 * DETERMINISTIK aniqlash — LLM'siz, xarajatsiz. Chaqiruvchi:
 * order-service `order.ai_resolve_preview` (bitta partiya = bitta RPC).
 *
 * ⚠️ order-service bu fayldan import QILMAYDI (ilovalar bir-birining
 * `src`iga bog'lanmaydi) — u shu shaklni o'z tomonida takrorlaydi. Maydon
 * nomi yoki ma'nosi o'zgarsa, order-service `ai-preview.types.ts` ham
 * birga o'zgarishi SHART.
 */

/** Bitta buyurtmaning joy matni. Har bir satr trim + 300 belgi bilan kesiladi. */
export interface DistrictTextQuery {
  region_name?: string | null;
  district_name?: string | null;
  address?: string | null;
  full_address?: string | null;
}

/** RMQ yuki: `{ items }` — ko'pi bilan `DISTRICT_RESOLVE_MAX_ITEMS` ta. */
export interface DistrictResolveByTextPayload {
  items?: unknown;
}

/**
 * Nega tuman avto-tanlanmadi (faqat ma'lumot uchun; preview buni
 * `district_missing` ga aylantiradi).
 *
 * - `region_ambiguous` — viloyat matni berilgan, lekin aniqlanmadi
 *   (yalang'och "Toshkent" yoki notanish nom) va tuman ham topilmadi.
 * - `district_not_found` — hech qanday mos tuman yo'q.
 * - `district_ambiguous` — bir nechta mos tuman, yoki SOATO'siz tumanni
 *   qulfsiz tasdiqlab bo'lmadi (R4) — operator tanlaydi.
 * - `no_place_signal` — tuman faqat manzildagi oddiy so'zdan topildi
 *   ("Uzun ko'chasi"), matnda "tuman/shahar" so'zi yoki district_name yo'q.
 * - `cross_region_confusable` — boshqa viloyatda juda o'xshash tuman bor
 *   (Mirzaobod ↔ Mirobod, Koson ↔ Kogon): jimgina tanlanmaydi (R2).
 * - `sato_mismatch` — tanlangan tumanning SOATO kodi o'z viloyati kodi bilan
 *   boshlanmaydi (R3): ma'lumot buzilgan, avto-tanlov RAD etiladi.
 */
export type DistrictResolutionReason =
  | 'region_ambiguous'
  | 'district_not_found'
  | 'district_ambiguous'
  | 'no_place_signal'
  | 'cross_region_confusable'
  | 'sato_mismatch';

/**
 * Operatorga taklif qilinadigan tuman. Frontend `AiDistrictCandidate`
 * (`{id, label, region_name}`) ning ustki to'plami.
 */
export interface DistrictCandidate {
  id: string;
  /** `${kanonik viloyat}, ${tuman}` — masalan "Toshkent viloyati, Chirchiq". */
  label: string;
  /**
   * DB `region.name` (trim qilingan). Frontend viloyatni aynan shu nom
   * bo'yicha topadi — kanonik nom BU YERGA yozilmaydi.
   */
  region_name: string;
  district_name: string;
}

export interface DistrictTextResolution {
  /** Tuman aniqlansa — HAR DOIM `district.region_id` (assigned_region EMAS). */
  region_id: string | null;
  /** Nomzodlar bo'sh bo'lmasa HAR DOIM null. */
  district_id: string | null;
  /** Kanonik viloyat nomi (`REGION_ALIASES`), bo'lmasa trim qilingan DB nomi. */
  region_label: string | null;
  /** `${kanonik viloyat}, ${tuman}` — faqat tuman aniqlanganda. */
  district_label: string | null;
  /** DB `region.name` (trim qilingan). */
  region_name: string | null;
  /** DB `district.name` (trim qilingan) — faqat tuman aniqlanganda. */
  district_name: string | null;
  /** Faqat `regionAlias(region_name)` viloyatni topganda true. */
  region_given: boolean;
  /** Ko'pi bilan `AI_MAX_CANDIDATES` ta. */
  candidates: DistrictCandidate[];
  reason?: DistrictResolutionReason;
}

/** Snapshot qatori: `regions` jadvali. */
export interface DistrictSnapshotRegion {
  id: string;
  name: string;
  sato_code: string | null;
}

/** Snapshot qatori: `districts` jadvali. */
export interface DistrictSnapshotDistrict {
  id: string;
  name: string;
  sato_code: string | null;
  region_id: string;
}

/**
 * Bitta so'rov uchun DB'dan BIR MARTA yuklangan viloyat + tumanlar.
 * ⚠️ O'zgarmas deb qaraladi: tayyorlangan indeks shu obyektga bog'lab
 * keshlanadi (WeakMap) — yuklangandan keyin massivlarni o'zgartirmang.
 */
export interface DistrictSnapshot {
  regions: ReadonlyArray<DistrictSnapshotRegion>;
  districts: ReadonlyArray<DistrictSnapshotDistrict>;
}
