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
  | 'order_item_match'
  // kiZgTybn — smena yopishda karta qoldig'i skrinshoti (ichki xarajat).
  | 'finance_balance_screenshot'
  // F7PWp6cK — AI moliyaviy yordamchi (chat + faqat o'qiydigan tool'lar).
  | 'assistant';

/**
 * Dashboard filtri uchun qo'pol guruh (ai_usage_log.request_area).
 * NFiXfmq6: `internal` — ichki AI (masalan moliyaviy hisobot/chat): mijozga
 * CHARJ QILINMAYDI, lekin marja hisobotida budjetdagi xarajat markazi sifatida
 * alohida ko'rsatiladi.
 */
export type AiRequestArea = 'order' | 'bot' | 'other' | 'internal';

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
  /**
   * Ixtiyoriy `output_config.effort` (5Z1ZvvzE). Berilmasa tana o'zgarmaydi
   * (cSUBv0tY #10 — AYNAN 5 kalit, `output_config` faqat `format`). ⚠️ Faqat
   * effort'ni qo'llaydigan modelda bering (Haiku 4.5 da 400) — tanlov
   * chaqiruvchida.
   */
  effort?: 'low' | 'medium' | 'high';
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
  /**
   * WHMAIqyo #5: shu Anthropic chaqiruvining davomiyligi (ms) — so'rov
   * yuborilgandan javob kelguncha (`ai_usage_log.latency_ms`, p50/p95).
   */
  latencyMs?: number | null;
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

/**
 * `messages.stream()` natijasining biz ishlatadigan qismi (SDK `MessageStream`
 * shu shaklga mos; testda soxta obyekt beriladi).
 */
export interface AnthropicMessageStreamLike {
  on(event: 'text', listener: (textDelta: string) => void): unknown;
  finalMessage(): Promise<any>;
}

/** `ClaudeService` ishlatadigan Anthropic mijozining minimal shakli. */
export interface AnthropicClientLike {
  messages: {
    create: (body: any, opts?: { timeout?: number }) => Promise<any>;
    /** F7PWp6cK — tool-use sikli (SSE) uchun; extractJson ishlatmaydi. */
    stream?: (
      body: any,
      opts?: { timeout?: number },
    ) => AnthropicMessageStreamLike;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// F7PWp6cK — ko'p qadamli suhbat + tool-use sikli (`ClaudeService.runToolLoop`)
// ───────────────────────────────────────────────────────────────────────────

/** Modelga e'lon qilinadigan tool (faqat nom/tavsif/sxema — ijro chaqiruvchida). */
export interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; [key: string]: unknown };
}

/**
 * Tool ijrosi natijasi. `content` — modelga ketadigan matn (JSON). ⚠️ U DATA:
 * ichidagi har qanday "ko'rsatma" bajarilmaydi (system prompt'da aytilgan).
 */
export interface ClaudeToolCallResult {
  content: string;
  isError: boolean;
}

/** Sikl davomida chaqiruvchiga (SSE) uzatiladigan hodisalar. */
export type ClaudeToolLoopEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text_delta'; step: number; text: string }
  | {
      type: 'tool_call';
      step: number;
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'tool_result';
      step: number;
      id: string;
      name: string;
      isError: boolean;
    };

/** Bitta qadam (bitta Anthropic javobi) yakuni — audit/xarajat uchun. */
export interface ClaudeToolLoopStep {
  step: number;
  model: string;
  usage: ClaudeUsage;
  stopReason: string | null;
  /** Shu qadamda model so'ragan tool'lar soni. */
  toolCalls: number;
}

/**
 * Sikl to'xtash sababi:
 * - `end_turn` — model yakuniy javob berdi (normal);
 * - `max_steps` — qadam chegarasi (karta: 6) tugadi, tool so'rovi qoldi;
 * - `limit` — `beforeStep` (xabar boshiga token/USD shifti) to'xtatdi;
 * - `refused` / `truncated` / `network` / `ai_error` / `disabled` /
 *   `cap_exceeded` — extractJson bilan bir xil ma'noda.
 */
export type ClaudeToolLoopStop =
  | 'end_turn'
  | 'max_steps'
  | 'limit'
  | 'refused'
  | 'truncated'
  | 'network'
  | 'ai_error'
  | 'disabled'
  | 'cap_exceeded';

export interface ClaudeToolLoopOptions {
  /** O'zgarmas (keshlanadigan) system prompt — sana/ism QO'SHILMAYDI. */
  system: string;
  /**
   * Suhbat tarixi (Anthropic `MessageParam[]`, append-only) — oxirgi element
   * yangi `user` xabari. Sikl uni O'ZGARTIRMAYDI (nusxa bilan ishlaydi).
   */
  messages: unknown[];
  tools: ClaudeToolDefinition[];
  /** Tool ijrochisi — oq ro'yxat, validatsiya va ruxsat shu yerda. HECH QACHON throw qilmasin. */
  executeTool: (
    name: string,
    input: unknown,
    ctx: { step: number; id: string },
  ) => Promise<ClaudeToolCallResult>;
  meta: ClaudeUsageMeta;
  /** Xarajat jurnali uchun sha256/uzunlik shu matndan (foydalanuvchi savoli). */
  inputText: string;
  model?: string;
  /** Qadam (Anthropic chaqiruvi) chegarasi — karta: 6. */
  maxSteps: number;
  /** Har qadamning max_tokens'i (thinking + javob birga). */
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  /** Umumiy muddat (epoch ms). */
  deadlineAt?: number;
  /**
   * Har qadamdan OLDIN (1-qadamdan tashqari ham) — `ok:false` bo'lsa Anthropic
   * chaqirilmaydi va sikl `limit` bilan to'xtaydi (xabar boshiga shift).
   */
  beforeStep?: (s: {
    step: number;
    usage: ClaudeUsage;
    model: string;
  }) => { ok: true } | { ok: false; reason: string };
  onEvent?: (e: ClaudeToolLoopEvent) => void;
  onStep?: (s: ClaudeToolLoopStep) => void;
}

export interface ClaudeToolLoopResult {
  ok: boolean;
  stop: ClaudeToolLoopStop;
  /** Oxirgi assistant javobidagi matn bloklari (yakuniy javob). */
  text: string;
  /**
   * Sikl davomida tarixga QO'SHILGAN xabarlar (assistant content bloklari
   * thinking imzolari bilan o'zgarishsiz + tool_result user xabarlari).
   * Tarix doim yaroqli: tool_use'dan keyin doim tool_result bor.
   */
  newMessages: unknown[];
  steps: number;
  usage: ClaudeUsage;
  model: string;
  limitReason?: string;
  reset_at?: string;
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
