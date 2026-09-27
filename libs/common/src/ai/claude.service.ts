import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { inspectAnthropicEnv } from './ai-key-check';
import {
  AI_MODEL_DEFAULTS,
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_CLIENT_FACTORY,
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_TIMEOUT_MS,
  CLAUDE_BUDGET_GUARD,
  CLAUDE_DEFAULT_MAX_TOKENS,
  CLAUDE_MIN_ATTEMPT_BUDGET_MS,
  CLAUDE_RETRY_MIN_BUDGET_MS,
  CLAUDE_USAGE_SINK,
} from './claude.constants';
import type {
  AnthropicClientFactory,
  AnthropicClientLike,
  AnthropicKeyInspection,
  ClaudeBudgetGuard,
  ClaudeFailureReason,
  ClaudeImageInput,
  ClaudeOutcome,
  ClaudeResult,
  ClaudeUsage,
  ClaudeUsageMeta,
  ClaudeUsageRecord,
  ClaudeUsageSink,
  ExtractJsonOptions,
} from './claude.types';

/**
 * Sukut fabrika — haqiqiy Anthropic SDK mijozi.
 *
 * ⚠️ `timeout` va `maxRetries` HAR DOIM aniq beriladi: SDK sukuti 10 daqiqa
 * va 2 retry; timeout berilmasa katta max_tokens (32000) uchun SDK o'zi
 * "Streaming is required" deb throw qiladi. Bo'sh kalit bilan CHAQIRILMAYDI
 * (`new Anthropic()` env'dan kalitni o'zi qidirib ketmasin).
 */
export const defaultAnthropicClientFactory: AnthropicClientFactory = (o) =>
  new Anthropic({
    apiKey: o.apiKey,
    timeout: o.timeout,
    maxRetries: o.maxRetries,
  });

/** SDK javobining biz o'qiydigan qismi (soxta mijoz ham shu shaklda). */
interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface AnthropicResponseLike {
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  content?: Array<{ type?: string; text?: unknown } | null> | null;
  usage?: AnthropicUsageLike | null;
}

type BudgetBlock =
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'cap_exceeded'; scope: 'global'; reset_at: string };

const LOG_ERROR_MAX_CHARS = 300;

function tokenCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.constructor?.name || err.name;
    return `${name}: ${err.message}`.slice(0, LOG_ERROR_MAX_CHARS);
  }
  return 'non-error throw';
}

/**
 * Birinchi `text` blokini JSON sifatida o'qiydi. Sonnet 5 sukut bo'yicha
 * thinking bloklarini (bo'sh matn) text'dan OLDIN qaytaradi — ular o'tkazib
 * yuboriladi.
 */
function parseFirstTextBlock(
  content: AnthropicResponseLike['content'],
): { ok: true; value: object } | { ok: false } {
  if (!Array.isArray(content)) return { ok: false };
  const block = content.find((b) => b?.type === 'text');
  const text = block?.text;
  if (typeof text !== 'string' || text.trim() === '') return { ok: false };
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Claude (Anthropic) uchun YAGONA darvoza — sxema majburlash, prompt caching,
 * xarajat jurnali kancasi, prompt-injection o'rami va xato siyosati BIR joyda.
 *
 * - ANTHROPIC_API_KEY bo'sh bo'lsa AI o'chiq (isEnabled()=false) — servis
 *   baribir normal ko'tariladi, chaqiruvchi qo'lda kiritish oqimiga qaytadi.
 * - extractJson() HECH QACHON throw qilmaydi: `null` o'rniga sababli natija
 *   (`ClaudeResult`) — UI har sabab uchun boshqa harakat ko'rsatadi.
 * - Model faqat matnni tushunadi — ID/narx kabi qiymatlarni KOD tekshiradi.
 *
 * ⚠️ Bu servisni FAQAT apps/ai-service import qiladi (kalit faqat o'sha
 * konteynerda). order-service LLM'ga faqat RMQ `ai.product.disambiguate`
 * orqali boradi.
 */
@Injectable()
export class ClaudeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: AnthropicClientLike | null;
  private readonly defaultModel: string;
  private readonly keyInfo: AnthropicKeyInspection;

  constructor(
    config: ConfigService,
    @Optional()
    @Inject(ANTHROPIC_CLIENT_FACTORY)
    factory?: AnthropicClientFactory,
    // Ixtiyoriy — AI xarajat jurnali. Berilmasa yozuv o'tkazib yuboriladi;
    // ClaudeService baribir ishlayveradi.
    @Optional()
    @Inject(CLAUDE_USAGE_SINK)
    private readonly usageSink?: ClaudeUsageSink,
    // Ixtiyoriy — global kunlik shift (avariya to'xtatgichi).
    @Optional()
    @Inject(CLAUDE_BUDGET_GUARD)
    private readonly budget?: ClaudeBudgetGuard,
  ) {
    const rawKey = config.get<unknown>(ANTHROPIC_API_KEY_ENV);
    const apiKey = typeof rawKey === 'string' ? rawKey.trim() : '';

    const rawModel = config.get<unknown>('AI_ORDER_MODEL');
    this.defaultModel =
      (typeof rawModel === 'string' ? rawModel.trim() : '') ||
      AI_MODEL_DEFAULTS.order;

    this.client = apiKey ? this.buildClient(factory, apiKey) : null;

    // Faqat NOMLAR — qiymat o'qilmaydi va logga chiqmaydi.
    const scan = inspectAnthropicEnv(process.env);
    this.keyInfo = apiKey
      ? { state: 'ok', misnamedKeys: scan.misnamedKeys }
      : {
          state: scan.misnamedKeys.length > 0 ? 'misnamed' : 'missing',
          misnamedKeys: scan.misnamedKeys,
        };
  }

  private buildClient(
    factory: AnthropicClientFactory | undefined,
    apiKey: string,
  ): AnthropicClientLike | null {
    try {
      return (factory ?? defaultAnthropicClientFactory)({
        apiKey,
        timeout: ANTHROPIC_TIMEOUT_MS,
        maxRetries: ANTHROPIC_MAX_RETRIES,
      });
    } catch (err) {
      // Mijoz qurilmasa ham servis ko'tariladi — AI o'chiq qoladi.
      this.logger.error(`Anthropic mijozi qurilmadi: ${describeError(err)}`);
      return null;
    }
  }

  /**
   * ⚠️ Startda BIR marta: kalit yo'q bo'lsa aniq WARN. Joi allowUnknown
   * ochiq, ya'ni xato nom bilan berilgan kalit (ANTROPIC_API_KEY) jim o'tadi —
   * shuning uchun o'xshash nomlar alohida WARN bilan NOMMA-NOM ko'rsatiladi.
   */
  onApplicationBootstrap(): void {
    if (this.client) {
      this.logger.log(`AI yoqiq — sukut model: ${this.defaultModel}`);
      return;
    }
    if (this.keyInfo.state === 'ok') return; // kalit bor, mijoz xatosi yuqorida loglangan
    this.logger.warn(`AI o'chiq — ${ANTHROPIC_API_KEY_ENV} yo'q`);
    if (this.keyInfo.state === 'misnamed') {
      this.logger.warn(
        `AI kaliti xato nom bilan berilgan: ${this.keyInfo.misnamedKeys.join(', ')} — ` +
          `kutilgan nom: ${ANTHROPIC_API_KEY_ENV}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /** Kalit holati — FAQAT env nomlari (ai.status javobi uchun). */
  keyState(): AnthropicKeyInspection {
    return {
      state: this.keyInfo.state,
      misnamedKeys: [...this.keyInfo.misnamedKeys],
    };
  }

  /**
   * System-prompt'ni PROMPT CACHING bilan uzatadi. Katta, o'zgarmas system
   * (ekstraksiya ~4200 token) takroriy chaqiruvlarda ~90% arzon o'qiladi
   * (cache_read = input*0.1). Anthropic minimal kesh chegarasidan kichik
   * promptlarni JIMGINA kesh qilmaydi — xato bermaydi, shunchaki oddiy narxda
   * ketadi. Kesh 5 daqiqa (ephemeral) — hajmli oqimda deyarli doim issiq.
   *
   * ⚠️ System matniga sana/market nomi/tuman ro'yxati kabi DINAMIK qiymat
   * qo'shilsa kesh jimgina o'ladi (xarajat ~4x) — o'zgaruvchi qism doim
   * user message'ga.
   */
  private cachedSystem(system: string): Anthropic.TextBlockParam[] {
    return [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  /**
   * Foydalanuvchi bloki: rasm(lar) + matn. Matn `<user_message>` ichida —
   * u DATA, ko'rsatma emas (prompt-injection himoyasi). Rasm bloklari
   * matndan OLDIN keladi.
   */
  private userContent(
    userText: string,
    images: ClaudeImageInput[],
  ): string | Anthropic.ContentBlockParam[] {
    const text = `<user_message>\n${userText}\n</user_message>`;
    if (images.length === 0) return text;
    return [
      ...images.map(
        (img): Anthropic.ImageBlockParam => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.dataBase64,
          },
        }),
      ),
      { type: 'text', text },
    ];
  }

  /**
   * Erkin matndan berilgan JSON sxemasiga mos strukturani ajratadi.
   * @returns `{ok:true,data}` yoki sababli `{ok:false,reason}` — throw YO'Q
   *
   * ⚠️ MAXFIYLIK: userText mijoz PII'sini (ism/telefon/manzil) o'z ichiga oladi
   * va Anthropic (AQSh) API'ga yuboriladi. Bosqich 4 (hardening): Anthropic bilan
   * DPA + qisqa retention, va imkon boricha PII maskalash kerak.
   * (Elchi: telefonlar chaqiruvchida — ai-service — [TEL_n] bilan maskalanadi;
   * userText HECH QACHON logga yozilmaydi, jurnalga faqat uzunlik va sha256.)
   *
   * Algoritm: bitta umumiy muddat (min(now+55s, deadlineAt)); har urinishdan
   * oldin qolgan vaqt va global shift tekshiriladi; max_tokens'da kesilsa
   * BIR marta 2x max_tokens bilan qayta urinadi (faqat ≥15s qolgan bo'lsa).
   */
  async extractJson<T = unknown>(
    opts: ExtractJsonOptions,
  ): Promise<ClaudeResult<T>> {
    const client = this.client;
    if (!client) return { ok: false, reason: 'disabled', attempts: 0 };

    let calls = 0;
    try {
      const deadline = Math.min(
        Date.now() + ANTHROPIC_TIMEOUT_MS,
        typeof opts.deadlineAt === 'number' && Number.isFinite(opts.deadlineAt)
          ? opts.deadlineAt
          : Infinity,
      );
      const model = opts.model?.trim() || this.defaultModel;
      let maxTokens = opts.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS;
      const images = opts.images ?? [];
      const content = this.userContent(opts.userText, images);
      const inputChars = opts.userText.length;
      const inputSha256 = createHash('sha256')
        .update(opts.userText, 'utf8')
        .digest('hex');

      for (const attempt of [1, 2] as const) {
        // 1-urinishda vaqt yetmasa — tarmoq/timeout holati; 2-urinishda esa
        // 1-javob kesilgan edi, ya'ni natija 'truncated'.
        const outOfTime: ClaudeFailureReason =
          attempt === 1 ? 'network' : 'truncated';
        if (deadline - Date.now() < CLAUDE_MIN_ATTEMPT_BUDGET_MS) {
          this.logBudgetExhausted(opts.meta, attempt, deadline);
          return { ok: false, reason: outOfTime, attempts: calls };
        }

        const block = await this.checkBudget(opts.meta);
        if (block) return { ...block, attempts: calls };

        // Umumiy muddatning QOLGANI — retry ham shu muddat ichida.
        const timeout = deadline - Date.now();
        if (timeout < CLAUDE_MIN_ATTEMPT_BUDGET_MS) {
          this.logBudgetExhausted(opts.meta, attempt, deadline);
          return { ok: false, reason: outOfTime, attempts: calls };
        }

        // ⚠️ Tana AYNAN 5 kalit: temperature/top_p/top_k/thinking BERILMAYDI
        // (Sonnet 5 da 400 qaytaradi; thinking sukut bo'yicha adaptive).
        const body: Anthropic.MessageCreateParamsNonStreaming = {
          model,
          max_tokens: maxTokens,
          system: this.cachedSystem(opts.system),
          messages: [{ role: 'user', content }],
          output_config: {
            format: { type: 'json_schema', schema: opts.schema },
          },
        };

        calls += 1;
        let raw: unknown;
        try {
          raw = await client.messages.create(body, { timeout });
        } catch (err) {
          return {
            ok: false,
            reason: this.classifyError(err, opts.meta, attempt),
            attempts: calls,
          };
        }

        const response = (raw ?? {}) as AnthropicResponseLike;
        const usage = this.readUsage(response.usage);
        const stopReason =
          typeof response.stop_reason === 'string'
            ? response.stop_reason
            : null;

        let outcome: ClaudeOutcome;
        let data: object | undefined;
        if (stopReason === 'refusal') {
          outcome = 'refused';
          // Faqat kategoriya — matn/izoh logga chiqmaydi.
          this.logger.warn(
            `Claude so'rovni rad etdi (refusal) feature=${opts.meta.feature} ` +
              `category=${response.stop_details?.category ?? 'null'}`,
          );
        } else if (stopReason === 'max_tokens') {
          outcome = 'truncated';
        } else {
          const parsed = parseFirstTextBlock(response.content);
          outcome = parsed.ok ? 'ok' : 'invalid_json';
          if (parsed.ok) data = parsed.value;
        }

        // Tokenlar sarflandi (natija valid bo'lmasa ham) — xarajat yoziladi.
        // Meta maydonlari ANIQ ko'chiriladi — tasodifiy qo'shimcha kalit
        // (masalan RMQ payload'idan) jurnalga tushmasin.
        const record: ClaudeUsageRecord = {
          feature: opts.meta.feature,
          requestArea: opts.meta.requestArea,
          marketId: opts.meta.marketId,
          userId: opts.meta.userId,
          traceId: opts.meta.traceId,
          draftId: opts.meta.draftId,
          model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          steps: attempt,
          stopReason,
          outcome,
          inputChars,
          inputSha256,
          imageCount: images.length,
        };
        this.emitUsage(record);
        await this.reportSpend(record);
        this.logger.log(
          `claude_usage feature=${opts.meta.feature} model=${model} ` +
            `stop_reason=${stopReason ?? 'null'} ` +
            `input_tokens=${usage.input_tokens} ` +
            `output_tokens=${usage.output_tokens} ` +
            `cache_creation_input_tokens=${usage.cache_creation_input_tokens} ` +
            `cache_read_input_tokens=${usage.cache_read_input_tokens}`,
        );

        if (outcome === 'ok') {
          return {
            ok: true,
            data: data as T,
            model,
            attempts: attempt,
            usage,
          };
        }
        if (outcome !== 'truncated') {
          if (outcome === 'invalid_json') {
            this.logger.warn(
              `Claude javobi JSON emas (invalid_json) feature=${opts.meta.feature}`,
            );
          }
          return { ok: false, reason: outcome, attempts: calls };
        }

        // ⚠️ Truncation: BIR marta, 2x max_tokens bilan, faqat umumiy
        // muddatdan ≥15s qolgan bo'lsa. UI va gateway o'zi qayta urinmaydi.
        if (
          attempt === 1 &&
          deadline - Date.now() >= CLAUDE_RETRY_MIN_BUDGET_MS
        ) {
          maxTokens *= 2;
          continue;
        }
        this.logger.warn(
          `Claude javobi kesildi (max_tokens=${maxTokens}) feature=${opts.meta.feature} — matnni bo'lish kerak`,
        );
        return { ok: false, reason: 'truncated', attempts: calls };
      }
      return { ok: false, reason: 'truncated', attempts: calls };
    } catch (err) {
      // Xavfsizlik to'ri — kutilmagan xato ham throw bo'lib chiqmaydi.
      this.logger.error(
        `Claude extractJson kutilmagan xato feature=${opts.meta?.feature}: ${describeError(err)}`,
      );
      return { ok: false, reason: 'ai_error', attempts: calls };
    }
  }

  private readUsage(u: AnthropicUsageLike | null | undefined): ClaudeUsage {
    return {
      input_tokens: tokenCount(u?.input_tokens),
      output_tokens: tokenCount(u?.output_tokens),
      cache_creation_input_tokens: tokenCount(u?.cache_creation_input_tokens),
      cache_read_input_tokens: tokenCount(u?.cache_read_input_tokens),
    };
  }

  /**
   * Global kunlik shift. ⚠️ FAIL-CLOSED: hisoblagichni o'qib bo'lmasa AI
   * o'chiq ('disabled') — bu pul darvozasi, ochiq qolmaydi.
   */
  private async checkBudget(
    meta: ClaudeUsageMeta,
  ): Promise<BudgetBlock | null> {
    if (!this.budget) return null;
    try {
      const decision = await this.budget.check();
      if (decision?.ok === true) return null;
      if (decision?.ok === false && decision.reason === 'cap_exceeded') {
        this.logger.warn(
          `ai_cap_exceeded feature=${meta.feature} reset_at=${decision.reset_at}`,
        );
        return {
          ok: false,
          reason: 'cap_exceeded',
          scope: 'global',
          reset_at: decision.reset_at,
        };
      }
      this.logger.error(
        `ai_cap_check_failed feature=${meta.feature}: noma'lum qaror`,
      );
      return { ok: false, reason: 'disabled' };
    } catch (err) {
      this.logger.error(
        `ai_cap_check_failed feature=${meta.feature}: ${describeError(err)}`,
      );
      return { ok: false, reason: 'disabled' };
    }
  }

  /**
   * Xarajat jurnali — FIRE-AND-FORGET. Sink'ning sinxron throw'i ham,
   * rad etilgan promise'i ham natijani buzmaydi (faqat WARN).
   */
  private emitUsage(record: ClaudeUsageRecord): void {
    const sink = this.usageSink;
    if (!sink) return;
    try {
      const ret: unknown = sink.record(record);
      if (ret instanceof Promise) {
        void ret.catch((err: unknown) =>
          this.logger.warn(
            `ai_usage_record_failed feature=${record.feature}: ${describeError(err)}`,
          ),
        );
      }
    } catch (err) {
      this.logger.warn(
        `ai_usage_record_failed feature=${record.feature}: ${describeError(err)}`,
      );
    }
  }

  /** Hisoblagichni oshirish (atomik UPSERT) — xatosi natijani buzmaydi. */
  private async reportSpend(record: ClaudeUsageRecord): Promise<void> {
    if (!this.budget) return;
    try {
      await this.budget.onSpend(record);
    } catch (err) {
      this.logger.warn(
        `ai_spend_update_failed feature=${record.feature}: ${describeError(err)}`,
      );
    }
  }

  /**
   * SDK xatosini sababga aylantiradi — eng aniq sinf BIRINCHI. Xabar matni
   * bo'yicha solishtirilmaydi (faqat instanceof va status).
   */
  private classifyError(
    err: unknown,
    meta: ClaudeUsageMeta,
    attempt: number,
  ): 'network' | 'ai_error' {
    const where = `feature=${meta.feature} attempt=${attempt}`;
    // APIConnectionTimeoutError ham APIConnectionError'ning vorisi.
    const isNetwork =
      err instanceof APIConnectionError ||
      err instanceof APIUserAbortError ||
      err instanceof RateLimitError ||
      err instanceof InternalServerError ||
      (err instanceof APIError &&
        typeof err.status === 'number' &&
        (err.status === 429 || err.status >= 500));
    if (isNetwork) {
      this.logger.warn(`Claude tarmoq xatosi ${where}: ${describeError(err)}`);
      return 'network';
    }
    if (err instanceof APIError) {
      this.logger.error(
        `Claude API xatosi ${where} status=${String(err.status ?? 'null')} ` +
          `type=${err.type ?? 'null'} request_id=${err.requestID ?? 'null'}: ${describeError(err)}`,
      );
      return 'ai_error';
    }
    this.logger.error(`Claude kutilmagan xato ${where}: ${describeError(err)}`);
    return 'ai_error';
  }

  private logBudgetExhausted(
    meta: ClaudeUsageMeta,
    attempt: number,
    deadline: number,
  ): void {
    this.logger.warn(
      `Claude chaqirilmadi — muddatga ${Math.max(0, deadline - Date.now())} ms qoldi ` +
        `(feature=${meta.feature} attempt=${attempt})`,
    );
  }
}
