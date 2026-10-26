import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import {
  AI_ASSISTANT_DEFAULT_DAILY_LIMIT,
  AI_ASSISTANT_MESSAGE_MAX_CHARS,
  ClaudeService,
  type AiAssistantAccessState,
  type AiAssistantErrorCode,
  type AiAssistantEvent,
  type AiAssistantMessageRequest,
  type AiAssistantRequester,
  type AiAssistantSource,
  type ClaudeToolLoopStep,
  type ClaudeUsage,
} from '@app/common';
import { computeCostUsd, roundUsd } from '../usage/ai-pricing';
import { nextTashkentMidnight, tashkentDay } from '../usage/tashkent-day';
import { AssistantReader } from './assistant-reader';
import { AssistantStore, type AppendRow } from './assistant-store.service';
import {
  assistantToolDefinitions,
  executeAssistantTool,
  type AssistantToolExecution,
} from './assistant-tools';
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildAssistantUserText,
} from './assistant.prompt';

const DIGITS_RE = /^\d{1,19}$/;
const LOG_ERROR_MAX_CHARS = 300;

/** Sukut model — karta: «Sonnet (sozlanadi)»; buyurtma oqimi bilan bir xil. */
export const AI_ASSISTANT_DEFAULT_MODEL = 'claude-sonnet-5';
/** Karta: «max 6 qadam». */
export const AI_ASSISTANT_MAX_STEPS = 6;

const ERROR_MESSAGES: Record<AiAssistantErrorCode, string> = {
  role_forbidden:
    'AI yordamchi faqat superadmin va ruxsat berilgan adminlar uchun',
  access_disabled: 'Sizga AI yordamchidan foydalanish ruxsati berilmagan',
  feature_disabled: "AI yordamchi hozircha o'chirilgan",
  ai_disabled: "AI xizmati o'chiq (kalit sozlanmagan)",
  daily_limit: 'Bugungi savollar limiti tugadi — ertaga qayta urinib ko‘ring',
  assistant_usd_cap: 'AI yordamchining bugungi xarajat shifti tugadi',
  cap_exceeded: 'AI ning bugungi umumiy xarajat shifti tugadi',
  busy: 'Oldingi savolga javob tayyorlanmoqda — biroz kuting',
  conversation_not_found: 'Suhbat topilmadi',
  conversation_full: 'Suhbat juda uzun — yangi suhbat boshlang',
  invalid_message: "Savol bo'sh yoki juda uzun",
  message_limit:
    'Bitta savol uchun token/xarajat chegarasiga yetildi — savolni toraytiring',
  refused: 'AI bu savolga javob bera olmadi',
  truncated: 'Javob juda uzun chiqdi — savolni toraytiring',
  network: "AI bilan aloqa uzildi — qayta urinib ko'ring",
  ai_error: 'AI xatosi — keyinroq urinib ko‘ring',
};

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.constructor?.name || err.name}: ${err.message}`.slice(
      0,
      LOG_ERROR_MAX_CHARS,
    );
  }
  return 'non-error throw';
}

function normRoles(roles: unknown): string[] {
  return Array.isArray(roles)
    ? roles
        .map((r) => (typeof r === 'string' ? r.trim().toLowerCase() : ''))
        .filter(Boolean)
    : [];
}

/**
 * F7PWp6cK — AI moliyaviy yordamchi (ai-service).
 *
 * Ruxsat (ai-service'da QAYTA tekshiriladi, gateway'ga ishonib qolinmaydi):
 * SUPERADMIN — doim; ADMIN — faqat `ai_assistant_access.enabled`; boshqa
 * rollar — rad. Funksiya sukut bo'yicha O'CHIQ (`AI_ASSISTANT_ENABLED`).
 *
 * Limitlar: foydalanuvchi kunlik savol limiti (Toshkent kuni, sukut 100 —
 * ⚠️ ega tasdig'i kutilmoqda), yordamchining kunlik USD shifti
 * (`ai_usage_log.feature='assistant'`), global kunlik shift (ClaudeService
 * budget guard, har qadamda), xabar boshiga token/USD shifti, 6 qadam,
 * foydalanuvchi bo'yicha bir vaqtda bitta savol, suhbat uzunligi.
 *
 * Audit: savol, har qadam (model, token, narx), har tool chaqiruvi (nom,
 * kirish, ok, yozuvlar soni, davr) va yakuniy javob manbalari bilan
 * `ai_messages` ga yoziladi; xarajat — `ai_usage_log` (feature 'assistant').
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly inFlight = new Set<string>();

  readonly enabled: boolean;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly defaultDailyLimit: number;
  readonly dailyUsdCap: number;
  readonly maxUsdPerMessage: number;
  readonly maxTokensPerMessage: number;
  readonly maxTurns: number;
  readonly maxHistoryChars: number;
  readonly maxConcurrent: number;

  constructor(
    config: ConfigService,
    private readonly claude: ClaudeService,
    private readonly store: AssistantStore,
    private readonly reader: AssistantReader,
  ) {
    const str = (key: string) => {
      const raw = config.get<unknown>(key);
      return typeof raw === 'string' ? raw.trim() : raw;
    };
    const numOr = (key: string, fallback: number, min = 0) => {
      const n = Number(str(key));
      return Number.isFinite(n) && n >= min ? n : fallback;
    };
    const enabledRaw = str('AI_ASSISTANT_ENABLED');
    this.enabled = enabledRaw === true || enabledRaw === 'true';
    const model = str('AI_ASSISTANT_MODEL');
    this.model =
      typeof model === 'string' && model ? model : AI_ASSISTANT_DEFAULT_MODEL;
    const effort = str('AI_ASSISTANT_EFFORT');
    this.effort =
      effort === 'low' || effort === 'high' || effort === 'medium'
        ? effort
        : 'medium';
    this.maxSteps = Math.min(
      AI_ASSISTANT_MAX_STEPS,
      Math.max(
        1,
        Math.floor(numOr('AI_ASSISTANT_MAX_STEPS', AI_ASSISTANT_MAX_STEPS, 1)),
      ),
    );
    this.maxTokens = Math.floor(numOr('AI_ASSISTANT_MAX_TOKENS', 8000, 1024));
    this.defaultDailyLimit = Math.floor(
      numOr('AI_ASSISTANT_DAILY_LIMIT', AI_ASSISTANT_DEFAULT_DAILY_LIMIT, 0),
    );
    this.dailyUsdCap = numOr('AI_ASSISTANT_DAILY_USD_CAP', 5, 0);
    this.maxUsdPerMessage = numOr('AI_ASSISTANT_MAX_USD_PER_MESSAGE', 0.5, 0);
    this.maxTokensPerMessage = Math.floor(
      numOr('AI_ASSISTANT_MAX_TOKENS_PER_MESSAGE', 200_000, 1000),
    );
    this.maxTurns = Math.floor(numOr('AI_ASSISTANT_MAX_TURNS', 20, 1));
    this.maxHistoryChars = Math.floor(
      numOr('AI_ASSISTANT_MAX_HISTORY_CHARS', 400_000, 10_000),
    );
    // RMQ xabari darhol ack qilinadi (prefetch slotini band qilmaydi) —
    // shuning uchun bir vaqtdagi yordamchi sikllari alohida cheklanadi.
    this.maxConcurrent = Math.floor(numOr('AI_ASSISTANT_MAX_CONCURRENT', 4, 1));
  }

  // ─── Ruxsat ─────────────────────────────────────────────────────────────

  async accessState(
    requester: AiAssistantRequester | null | undefined,
  ): Promise<AiAssistantAccessState> {
    const roles = new Set(normRoles(requester?.roles));
    const id = String(requester?.id ?? '').trim();
    const base = {
      feature_enabled: this.enabled,
      reset_at: nextTashkentMidnight(),
    };
    const isSuper = roles.has('superadmin');
    const isAdmin = roles.has('admin');
    if ((!isSuper && !isAdmin) || !DIGITS_RE.test(id)) {
      return {
        ...base,
        allowed: false,
        reason: 'role_forbidden',
        daily_limit: 0,
        used_today: 0,
        remaining_today: 0,
      };
    }
    const row = await this.store.getAccess(id);
    const dailyLimit =
      row?.daily_limit !== null && row?.daily_limit !== undefined
        ? row.daily_limit
        : this.defaultDailyLimit;
    const used = await this.store.countQuestionsToday(id);
    const remaining = Math.max(0, dailyLimit - used);
    let reason: AiAssistantAccessState['reason'] = null;
    if (!isSuper && row?.enabled !== true) reason = 'access_disabled';
    else if (!this.enabled) reason = 'feature_disabled';
    else if (!this.claude.isEnabled()) reason = 'ai_disabled';
    return {
      ...base,
      allowed: reason === null,
      reason,
      daily_limit: dailyLimit,
      used_today: used,
      remaining_today: remaining,
    };
  }

  // ─── Suhbat (SSE oqimi) ─────────────────────────────────────────────────

  /**
   * Hodisalar oqimi. HECH QACHON xato bilan tugamaydi — har muammo `error`
   * hodisasi; oqim doim `complete` bo'ladi (RMQ javob navbati toza yopiladi).
   */
  stream(req: AiAssistantMessageRequest): Observable<AiAssistantEvent> {
    return new Observable<AiAssistantEvent>((subscriber) => {
      const emit = (event: AiAssistantEvent) => {
        if (!subscriber.closed) subscriber.next(event);
      };
      this.run(req, emit)
        .catch((err: unknown) => {
          this.logger.error(`assistant_run_failed: ${describeError(err)}`);
          emit({
            type: 'error',
            code: 'ai_error',
            message: ERROR_MESSAGES.ai_error,
          });
        })
        .finally(() => subscriber.complete());
    });
  }

  private fail(
    emit: (e: AiAssistantEvent) => void,
    code: AiAssistantErrorCode,
    extra: { conversation_id?: string | null; reset_at?: string } = {},
  ): void {
    emit({ type: 'error', code, message: ERROR_MESSAGES[code], ...extra });
  }

  private async run(
    req: AiAssistantMessageRequest,
    emit: (e: AiAssistantEvent) => void,
  ): Promise<void> {
    const message = typeof req?.message === 'string' ? req.message.trim() : '';
    if (!message || message.length > AI_ASSISTANT_MESSAGE_MAX_CHARS) {
      return this.fail(emit, 'invalid_message');
    }
    const conversationId =
      req?.conversation_id === null || req?.conversation_id === undefined
        ? null
        : String(req.conversation_id).trim();
    if (conversationId !== null && !DIGITS_RE.test(conversationId)) {
      return this.fail(emit, 'conversation_not_found');
    }

    const access = await this.accessState(req?.requester);
    if (!access.allowed) {
      return this.fail(emit, access.reason ?? 'role_forbidden');
    }
    const requester: AiAssistantRequester = {
      id: String(req.requester.id).trim(),
      roles: normRoles(req.requester.roles),
      branch_id: req.requester.branch_id ?? null,
    };
    const userId = requester.id;

    if (this.inFlight.has(userId) || this.inFlight.size >= this.maxConcurrent) {
      return this.fail(emit, 'busy');
    }
    this.inFlight.add(userId);
    try {
      const spent = await this.store.assistantSpendTodayUsd();
      if (this.dailyUsdCap > 0 && spent >= this.dailyUsdCap) {
        return this.fail(emit, 'assistant_usd_cap', {
          reset_at: nextTashkentMidnight(),
        });
      }

      const today = tashkentDay();
      const userText = buildAssistantUserText(today, message);
      const userContent = [{ type: 'text', text: userText }];
      const traceId =
        typeof req.trace_id === 'string' ? req.trace_id.slice(0, 64) : null;
      const reserved = await this.store.reserveQuestion({
        userId,
        conversationId,
        title: message.replace(/\s+/g, ' '),
        text: message,
        content: userContent,
        dailyLimit: access.daily_limit,
        maxTurns: this.maxTurns,
        maxHistoryChars: this.maxHistoryChars,
        traceId,
      });
      if (!reserved.ok) {
        return this.fail(emit, reserved.code, {
          conversation_id: conversationId,
          ...(reserved.code === 'daily_limit'
            ? { reset_at: nextTashkentMidnight() }
            : {}),
        });
      }
      const conversation = reserved.conversation;
      emit({
        type: 'meta',
        conversation_id: conversation.id,
        message_id: reserved.questionId,
        model: this.model,
        max_steps: this.maxSteps,
      });

      const executions = new Map<string, AssistantToolExecution>();
      const sources: AiAssistantSource[] = [];
      const steps: ClaudeToolLoopStep[] = [];
      const toolCtx = { reader: this.reader, requester, today };

      const result = await this.claude.runToolLoop({
        system: ASSISTANT_SYSTEM_PROMPT,
        messages: [...reserved.history, { role: 'user', content: userContent }],
        tools: assistantToolDefinitions(requester.roles),
        inputText: message,
        model: this.model,
        maxSteps: this.maxSteps,
        maxTokens: this.maxTokens,
        effort: this.effort,
        meta: {
          feature: 'assistant',
          requestArea: 'internal',
          marketId: null,
          userId,
          traceId,
          draftId: null,
        },
        beforeStep: ({ usage, model }) => this.messageGuard(usage, model),
        executeTool: async (name, input, ctx) => {
          const exec = await executeAssistantTool(name, input, toolCtx);
          executions.set(ctx.id, exec);
          if (exec.source) sources.push(exec.source);
          if (exec.failure) {
            this.logger.warn(
              `assistant_tool_failed tool=${name} user=${userId}: ${exec.failure}`,
            );
          }
          return exec.result;
        },
        onEvent: (e) => {
          if (e.type === 'step_start') emit({ type: 'step', step: e.step });
          else if (e.type === 'text_delta') {
            emit({ type: 'delta', step: e.step, text: e.text });
          } else if (e.type === 'tool_call') {
            emit({
              type: 'tool_call',
              step: e.step,
              id: e.id,
              tool: e.name,
              input:
                e.input &&
                typeof e.input === 'object' &&
                !Array.isArray(e.input)
                  ? (e.input as Record<string, unknown>)
                  : {},
            });
          } else if (e.type === 'tool_result') {
            const exec = executions.get(e.id);
            emit({
              type: 'tool_result',
              step: e.step,
              id: e.id,
              tool: e.name,
              ok: !e.isError,
              records: exec?.records ?? 0,
              period: exec?.source?.period ?? null,
              truncated: exec?.source?.truncated ?? false,
            });
          }
        },
        onStep: (s) => steps.push(s),
      });

      const costUsd = roundUsd(
        computeCostUsd({
          model: result.model,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cacheCreationTokens: result.usage.cache_creation_input_tokens,
          cacheReadTokens: result.usage.cache_read_input_tokens,
        }),
      );

      const answered =
        result.stop === 'end_turn' ||
        result.stop === 'max_steps' ||
        (result.stop === 'truncated' && result.text.trim().length > 0);
      let answer = result.text.trim();
      if (result.stop === 'max_steps') {
        answer =
          (answer ? `${answer}\n\n` : '') +
          `_(${this.maxSteps} qadam chegarasiga yetildi — savolni aniqroq bering.)_`;
      } else if (result.stop === 'truncated' && answered) {
        answer += '\n\n_(Javob qisqartirildi.)_';
      }

      const rows = this.buildRows(result.newMessages, steps, executions);
      const finalRow: AppendRow = {
        role: 'assistant',
        text: answered ? answer : ERROR_MESSAGES[this.errorCode(result.stop)],
        content: null,
        sources,
        is_final: true,
        model: result.model,
        stop_reason: result.stop,
        cost_usd: 0,
      };
      // Yakuniy matnli assistant qatori bo'lsa — o'sha qator final bo'ladi.
      const last = rows[rows.length - 1];
      if (answered && last && last.role === 'assistant') {
        last.is_final = true;
        last.sources = sources;
        last.text = answer;
        last.stop_reason = result.stop;
      } else {
        rows.push(finalRow);
      }
      let finalId: string | null = null;
      try {
        finalId = await this.store.appendMessages(
          conversation,
          userId,
          reserved.nextSeq,
          rows,
          traceId,
        );
      } catch (err) {
        this.logger.error(
          `assistant_audit_write_failed conversation=${conversation.id}: ${describeError(err)}`,
        );
      }

      this.logger.log(
        `assistant_answer user=${userId} conversation=${conversation.id} stop=${result.stop} ` +
          `steps=${result.steps} tools=${sources.length} cost_usd=${costUsd}`,
      );

      if (!answered) {
        return this.fail(emit, this.errorCode(result.stop), {
          conversation_id: conversation.id,
          ...(result.reset_at ? { reset_at: result.reset_at } : {}),
        });
      }
      emit({
        type: 'done',
        conversation_id: conversation.id,
        message_id: finalId ?? reserved.questionId,
        answer,
        stop: result.stop,
        steps: result.steps,
        sources,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_read_tokens: result.usage.cache_read_input_tokens,
          cache_creation_tokens: result.usage.cache_creation_input_tokens,
          cost_usd: costUsd,
        },
        limits: {
          daily_limit: access.daily_limit,
          used_today: reserved.usedToday,
          remaining_today: Math.max(0, access.daily_limit - reserved.usedToday),
        },
      });
    } finally {
      this.inFlight.delete(userId);
    }
  }

  /** Xabar boshiga shift — har qadamdan OLDIN. */
  private messageGuard(
    usage: ClaudeUsage,
    model: string,
  ): { ok: true } | { ok: false; reason: string } {
    const cost = computeCostUsd({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
    });
    if (this.maxUsdPerMessage > 0 && cost >= this.maxUsdPerMessage) {
      return { ok: false, reason: 'message_usd_cap' };
    }
    const tokens =
      usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens;
    if (tokens >= this.maxTokensPerMessage) {
      return { ok: false, reason: 'message_token_cap' };
    }
    return { ok: true };
  }

  private errorCode(stop: string): AiAssistantErrorCode {
    switch (stop) {
      case 'refused':
        return 'refused';
      case 'truncated':
        return 'truncated';
      case 'network':
        return 'network';
      case 'disabled':
        return 'ai_disabled';
      case 'cap_exceeded':
        return 'cap_exceeded';
      case 'limit':
        return 'message_limit';
      default:
        return 'ai_error';
    }
  }

  /**
   * Sikl qo'shgan xabarlar → audit qatorlari. Har assistant xabari o'z
   * qadamining usage'i bilan (refusal / kesilgan tool qadamlari tarixga
   * qo'shilmagan — ularning xarajati `ai_usage_log` da).
   */
  private buildRows(
    newMessages: unknown[],
    steps: ClaudeToolLoopStep[],
    executions: Map<string, AssistantToolExecution>,
  ): AppendRow[] {
    const appendedSteps = steps.filter(
      (s) =>
        s.stopReason !== 'refusal' &&
        !(s.stopReason === 'max_tokens' && s.toolCalls > 0),
    );
    let stepIdx = 0;
    const rows: AppendRow[] = [];
    for (const raw of newMessages) {
      const msg = raw as { role?: string; content?: unknown };
      if (msg.role === 'assistant') {
        const s = appendedSteps[stepIdx++];
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const text = blocks
          .filter(
            (b): b is { type: 'text'; text: string } =>
              !!b && (b as { type?: string }).type === 'text',
          )
          .map((b) => b.text)
          .join('');
        rows.push({
          role: 'assistant',
          text: text || null,
          content: msg.content,
          model: s?.model ?? null,
          step: s?.step ?? null,
          stop_reason: s?.stopReason ?? null,
          input_tokens: s?.usage.input_tokens ?? 0,
          output_tokens: s?.usage.output_tokens ?? 0,
          cache_read_tokens: s?.usage.cache_read_input_tokens ?? 0,
          cache_creation_tokens: s?.usage.cache_creation_input_tokens ?? 0,
          cost_usd: s
            ? roundUsd(
                computeCostUsd({
                  model: s.model,
                  inputTokens: s.usage.input_tokens,
                  outputTokens: s.usage.output_tokens,
                  cacheCreationTokens: s.usage.cache_creation_input_tokens,
                  cacheReadTokens: s.usage.cache_read_input_tokens,
                }),
              )
            : 0,
        });
      } else {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const toolCalls = blocks.map((b) => {
          const rawId = (b as { tool_use_id?: unknown }).tool_use_id;
          const id = typeof rawId === 'string' ? rawId : '';
          const exec = executions.get(id);
          return {
            tool_use_id: id,
            tool: exec?.source?.tool ?? null,
            input: exec?.input ?? null,
            ok: exec ? !exec.result.isError : false,
            records: exec?.records ?? 0,
            period: exec?.source?.period ?? null,
            truncated: exec?.source?.truncated ?? false,
          };
        });
        rows.push({
          role: 'tool',
          text: null,
          content: msg.content,
          tool_calls: toolCalls,
        });
      }
    }
    return rows;
  }

  // ─── Suhbatlar ──────────────────────────────────────────────────────────

  async listConversations(
    requester: AiAssistantRequester,
    limit?: number,
    offset?: number,
  ) {
    const id = String(requester?.id ?? '');
    const take = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    const skip = Math.max(0, Math.floor(Number(offset) || 0));
    const [rows, total] = await this.store.listConversations(id, take, skip);
    return {
      items: rows.map((c) => ({
        id: c.id,
        title: c.title,
        turns: c.turns,
        last_message_at: c.last_message_at,
        created_at: c.createdAt,
        cost_usd: c.cost_usd,
      })),
      total,
      limit: take,
      offset: skip,
    };
  }

  async getConversation(requester: AiAssistantRequester, id: string) {
    if (!DIGITS_RE.test(String(id ?? ''))) return null;
    const found = await this.store.getConversation(
      String(requester?.id ?? ''),
      String(id),
    );
    if (!found) return null;
    const { conversation, messages } = found;
    return {
      id: conversation.id,
      title: conversation.title,
      turns: conversation.turns,
      created_at: conversation.createdAt,
      last_message_at: conversation.last_message_at,
      cost_usd: conversation.cost_usd,
      messages: messages
        .filter((m) => m.role === 'user' || m.is_final)
        .map((m) => ({
          id: m.id,
          role: m.role === 'user' ? 'user' : 'assistant',
          text: m.text ?? '',
          created_at: m.createdAt,
          ...(m.role === 'user'
            ? {}
            : {
                sources: Array.isArray(m.sources) ? m.sources : [],
                stop: m.stop_reason,
              }),
        })),
    };
  }

  // ─── Ruxsatlarni boshqarish (SUPERADMIN) ────────────────────────────────

  async listAccess() {
    const rows = await this.store.listAccess();
    return {
      feature_enabled: this.enabled,
      default_daily_limit: this.defaultDailyLimit,
      model: this.model,
      items: rows.map((r) => ({
        user_id: r.user_id,
        enabled: r.enabled,
        daily_limit: r.daily_limit,
        effective_daily_limit: r.daily_limit ?? this.defaultDailyLimit,
        updated_by: r.updated_by,
        updated_at: r.updatedAt,
      })),
    };
  }

  async updateAccess(
    requester: AiAssistantRequester,
    userId: string,
    enabled: boolean,
    dailyLimit: number | null,
  ) {
    const row = await this.store.upsertAccess(
      String(userId),
      enabled === true,
      dailyLimit,
      String(requester?.id ?? ''),
    );
    this.logger.log(
      `assistant_access_updated user=${row.user_id} enabled=${row.enabled} ` +
        `daily_limit=${row.daily_limit ?? 'default'} by=${row.updated_by}`,
    );
    return {
      user_id: row.user_id,
      enabled: row.enabled,
      daily_limit: row.daily_limit,
      effective_daily_limit: row.daily_limit ?? this.defaultDailyLimit,
      updated_by: row.updated_by,
      updated_at: row.updatedAt,
    };
  }
}
