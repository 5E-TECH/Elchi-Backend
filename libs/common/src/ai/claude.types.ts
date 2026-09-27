/**
 * Anthropic (Claude) bilan gaplashadigan YAGONA darvoza — `ClaudeService` —
 * uchun tiplar va portlar (C2 kontrakti). Bu fayldagi nomlar MUZLATILGAN:
 * ai-service, order-service va api-gateway shu tiplarga qarab yoziladi.
 *
 * ⚠️ Bu yerda FAQAT tiplar bor. DI tokenlari va konstantalar
 * `claude.constants.ts` da, runtime mantiq `claude.service.ts` da.
 */

/**
 * `extractJson` muvaffaqiyatsiz bo'lganda qaytadigan sabab. `null` o'rniga
 * diskriminatsiyalangan sabab — UI har sabab uchun BOSHQA harakat ko'rsatadi
 * (bVeyEuIR): network → "Qayta urinib ko'ring", refused/disabled → "Qo'lda
 * kiritish", truncated → "matnni bo'ling".
 */
export type ClaudeFailureReason =
  | 'disabled'
  | 'refused'
  | 'truncated'
  | 'network'
  | 'invalid_json'
  | 'ai_error';

/** ai-service RMQ javobidagi sabab: Claude sabablari + global kunlik shift. */
export type AiParseReason = ClaudeFailureReason | 'cap_exceeded';

/** Xarajat jurnali (ai_usage_log.feature) uchun aniq amal nomi. */
export type AiFeature =
  | 'order_extract_multi'
  | 'order_extract_image'
  | 'order_district'
  | 'order_item_match';

/** Dashboard filtri uchun qo'pol guruh (ai_usage_log.request_area). */
export type AiRequestArea = 'order' | 'bot' | 'other';

/**
 * Har Claude chaqiruvining MAJBURIY meta'si (lYVuADRE #4/#5/#16).
 *
 * ⚠️ HAMMA kalitlar required (optional EMAS) — qiymat `null` bo'lishi mumkin,
 * lekin kalitni UNUTIB bo'lmaydi: yangi chaqiruv joyi meta'ni to'liq bermasa
 * kompilyatsiya sinadi. BeePostda 62/62 qatorda order_id/user_id NULL qolgan —
 * sababi aynan optional meta edi.
 */
export interface ClaudeUsageMeta {
  feature: AiFeature;
  requestArea: AiRequestArea;
  marketId: string | null;
  userId: string | null;
  traceId: string | null;
  draftId: string | null;
}

/** Anthropic javobidagi `usage` — null qiymatlar 0 ga keltirilgan. */
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * `extractJson` natijasi — HECH QACHON throw qilinmaydi, har holat shu union
 * bilan qaytadi. `attempts` — Anthropic'ga necha marta so'rov ketgani.
 */
export type ClaudeResult<T> =
  | { ok: true; data: T; model: string; attempts: 1 | 2; usage: ClaudeUsage }
  | { ok: false; reason: ClaudeFailureReason; attempts: number }
  | {
      ok: false;
      reason: 'cap_exceeded';
      scope: 'global';
      reset_at: string;
      attempts: number;
    };

/** Vision kirishi: base64 (data: prefiksiz) va Anthropic qo'llagan MIME. */
export interface ClaudeImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  dataBase64: string;
}

export interface ExtractJsonOptions {
  /** O'zgarmas system prompt — kesh prefiksi (dinamik qiymat QO'SHILMASIN). */
  system: string;
  /** Foydalanuvchi matni (telefonlar allaqachon [TEL_n] bilan maskalangan). */
  userText: string;
  /** Structured outputs JSON sxemasi (min/max/minLength YO'Q). */
  schema: Record<string, unknown>;
  meta: ClaudeUsageMeta;
  model?: string;
  maxTokens?: number;
  images?: ClaudeImageInput[];
  /** Umumiy muddat (epoch ms) — RPC zanjiridan keladi. */
  deadlineAt?: number;
}

/** Javob olingan chaqiruvning natijasi (xarajat yozuvi uchun). */
export type ClaudeOutcome = 'ok' | 'refused' | 'truncated' | 'invalid_json';

/**
 * Bitta Anthropic JAVOBI uchun xarajat yozuvi (har retry alohida yozuv).
 *
 * ⚠️ Xom matn YO'Q — faqat uzunlik (inputChars), sha256 (inputSha256) va
 * rasm soni. PII jurnalga tushmaydi.
 */
export interface ClaudeUsageRecord extends ClaudeUsageMeta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Urinish raqami (1 yoki 2). */
  steps: number;
  stopReason: string | null;
  outcome: ClaudeOutcome;
  inputChars: number;
  inputSha256: string;
  imageCount: number;
}

/**
 * Xarajat jurnali porti (ai-service `AiUsageService` amalga oshiradi).
 * FIRE-AND-FORGET: `record` kutilmaydi va uning xatosi natijani buzmaydi.
 */
export interface ClaudeUsageSink {
  record(r: ClaudeUsageRecord): void;
}

export type ClaudeBudgetDecision =
  | { ok: true }
  | { ok: false; reason: 'cap_exceeded'; scope: 'global'; reset_at: string };

/**
 * Global kunlik shift porti (ai-service `AiBudgetService` amalga oshiradi).
 * `check()` Anthropic chaqiruvidan OLDIN; throw qilsa AI FAIL-CLOSED ('disabled').
 * `onSpend()` har javobdan keyin atomik UPSERT bilan hisoblagichni oshiradi.
 */
export interface ClaudeBudgetGuard {
  check(): Promise<ClaudeBudgetDecision>;
  onSpend(r: ClaudeUsageRecord): Promise<void>;
}

/** `ClaudeService` ishlatadigan Anthropic mijozining minimal shakli. */
export interface AnthropicClientLike {
  messages: {
    create: (body: any, opts?: { timeout?: number }) => Promise<any>;
  };
}

/**
 * Anthropic mijozini quradigan fabrika. Testda soxta mijoz beriladi —
 * haqiqiy SDK va tarmoq ishlatilmaydi.
 */
export type AnthropicClientFactory = (o: {
  apiKey: string;
  timeout: number;
  maxRetries: number;
}) => AnthropicClientLike;

/** ANTHROPIC_API_KEY holati: bor / yo'q / xato nom bilan berilgan. */
export type AnthropicKeyState = 'ok' | 'missing' | 'misnamed';

/** Kalit tekshiruvi natijasi — FAQAT env NOMLARI, hech qachon qiymat emas. */
export interface AnthropicKeyInspection {
  state: AnthropicKeyState;
  misnamedKeys: string[];
}
