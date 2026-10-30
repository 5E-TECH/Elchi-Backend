/**
 * F7PWp6cK — AI moliyaviy yordamchi: gateway ↔ ai-service kontrakti.
 *
 * Bu faylda FAQAT tiplar va muzlatilgan ro'yxatlar (oq ro'yxat): tool nomlari,
 * har tool o'qiydigan RMQ buyruqlari va har tool'ga MOS HTTP endpointlar.
 * Gateway testi (`ai-assistant-gateway.tool-roles.spec.ts`) har tool'ning
 * rollari mos endpoint(lar)ning `@Roles` dan KENG emasligini tekshiradi —
 * foydalanuvchi yordamchi orqali API'dan ko'proq narsa o'qiy olmaydi.
 */

/** Yordamchidan foydalana oladigan rollar (boshqalari — 403). */
export const AI_ASSISTANT_ALLOWED_ROLES = ['superadmin', 'admin'] as const;
export type AiAssistantRole = (typeof AI_ASSISTANT_ALLOWED_ROLES)[number];

/** Sukut kunlik so'rov limiti (Toshkent kuni) — `ai_assistant_access.daily_limit` bo'sh bo'lsa. */
export const AI_ASSISTANT_DEFAULT_DAILY_LIMIT = 100;

/** Xabar matni chegarasi (belgi). */
export const AI_ASSISTANT_MESSAGE_MAX_CHARS = 2000;

/**
 * Kartadagi 9 ta FAQAT O'QIYDIGAN tool + T3-4 `get_receipt_checks`. Tartib
 * o'zgarmaydi (tool ro'yxati prompt prefiksida — tartib o'zgarsa kesh
 * o'ladi); yangi tool — FAQAT oxiriga.
 */
export const AI_ASSISTANT_TOOL_NAMES = [
  'get_cash_position',
  'get_cashbox_history',
  'get_courier_debts',
  'get_market_payables',
  'get_branch_settlements',
  'get_shift_summaries',
  'get_expenses_by_category',
  'get_revenue_profit',
  'get_order_flow',
  'get_receipt_checks',
] as const;
export type AiAssistantToolName = (typeof AI_ASSISTANT_TOOL_NAMES)[number];

/** Tool o'qiy oladigan servis mijozlari (ai-service'da ro'yxatdan o'tgan). */
export type AiAssistantReadClient = 'FINANCE' | 'ANALYTICS' | 'BRANCH';

/**
 * RMQ OQ RO'YXATI — yordamchi faqat shu buyruqlarni yubora oladi. Hammasi
 * mavjud O'QISH handler'lari (yozuvchi pattern yo'q — test tekshiradi).
 */
export const AI_ASSISTANT_READ_PATTERNS: ReadonlyArray<{
  client: AiAssistantReadClient;
  cmd: string;
}> = Object.freeze([
  { client: 'FINANCE', cmd: 'finance.cashbox.financial_balance' },
  { client: 'FINANCE', cmd: 'finance.cashbox.cards.list' },
  { client: 'FINANCE', cmd: 'finance.history.find_all' },
  { client: 'FINANCE', cmd: 'finance.shift.find_all' },
  { client: 'FINANCE', cmd: 'finance.cashbox.expense_categories.list' },
  { client: 'FINANCE', cmd: 'finance.financial_balance.analytics' },
  { client: 'ANALYTICS', cmd: 'analytics.revenue' },
  { client: 'ANALYTICS', cmd: 'analytics.dashboard' },
  { client: 'BRANCH', cmd: 'branch.find_all' },
  { client: 'FINANCE', cmd: 'finance.receipt_checks.summary' },
]);

/**
 * Har tool'ga MOS mavjud HTTP endpointlar (gateway controller sinfi + metod).
 * Tool ruxsati = shu endpointlar `@Roles` ning KESISHMASI ∩ {superadmin, admin}.
 */
export const AI_ASSISTANT_TOOL_ENDPOINTS: Readonly<
  Record<
    AiAssistantToolName,
    ReadonlyArray<{ route: string; controller: string; handler: string }>
  >
> = Object.freeze({
  get_cash_position: [
    {
      route: 'GET /finance/cashbox/financial-balanse',
      controller: 'FinanceGatewayController',
      handler: 'financialBalance',
    },
    {
      route: 'GET /finance/cashbox/cards',
      controller: 'FinanceGatewayController',
      handler: 'listCashboxCards',
    },
  ],
  get_cashbox_history: [
    {
      route: 'GET /finance/history',
      controller: 'FinanceGatewayController',
      handler: 'findHistory',
    },
  ],
  get_courier_debts: [
    {
      route: 'GET /finance/cashbox/financial-balanse',
      controller: 'FinanceGatewayController',
      handler: 'financialBalance',
    },
  ],
  get_market_payables: [
    {
      route: 'GET /finance/cashbox/financial-balanse',
      controller: 'FinanceGatewayController',
      handler: 'financialBalance',
    },
  ],
  get_branch_settlements: [
    {
      route: 'GET /finance/cashbox/financial-balanse',
      controller: 'FinanceGatewayController',
      handler: 'financialBalance',
    },
    {
      route: 'GET /branches',
      controller: 'BranchGatewayController',
      handler: 'findAllBranches',
    },
  ],
  get_shift_summaries: [
    {
      route: 'GET /finance/shift',
      controller: 'FinanceGatewayController',
      handler: 'findShifts',
    },
  ],
  get_expenses_by_category: [
    {
      route: 'GET /finance/history',
      controller: 'FinanceGatewayController',
      handler: 'findHistory',
    },
    {
      route: 'GET /finance/cashbox/expense-categories',
      controller: 'FinanceGatewayController',
      handler: 'listCashboxExpenseCategories',
    },
  ],
  get_revenue_profit: [
    {
      route: 'GET /analytics/revenue',
      controller: 'AnalyticsGatewayController',
      handler: 'getRevenue',
    },
    {
      route: 'GET /finance/financial-balance/analytics',
      controller: 'FinanceGatewayController',
      handler: 'financialBalanceAnalytics',
    },
  ],
  get_order_flow: [
    {
      route: 'GET /analytics/dashboard',
      controller: 'AnalyticsGatewayController',
      handler: 'getDashboard',
    },
  ],
  get_receipt_checks: [
    {
      route: 'GET /finance/receipts/summary',
      controller: 'FinanceGatewayController',
      handler: 'receiptChecksSummary',
    },
  ],
});

/** Har tool chaqira oladigan rollar (endpoint rollari bilan test tenglashtiradi). */
export const AI_ASSISTANT_TOOL_ROLES: Readonly<
  Record<AiAssistantToolName, readonly AiAssistantRole[]>
> = Object.freeze({
  get_cash_position: ['superadmin', 'admin'],
  get_cashbox_history: ['superadmin', 'admin'],
  get_courier_debts: ['superadmin', 'admin'],
  get_market_payables: ['superadmin', 'admin'],
  get_branch_settlements: ['superadmin', 'admin'],
  get_shift_summaries: ['superadmin', 'admin'],
  get_expenses_by_category: ['superadmin', 'admin'],
  get_revenue_profit: ['superadmin', 'admin'],
  get_order_flow: ['superadmin', 'admin'],
  get_receipt_checks: ['superadmin', 'admin'],
});

/** JWT'dan olingan so'rovchi (gateway beradi; ai-service qayta tekshiradi). */
export interface AiAssistantRequester {
  id: string;
  roles: string[];
  branch_id?: string | null;
}

export interface AiAssistantMessageRequest {
  requester: AiAssistantRequester;
  conversation_id?: string | null;
  message: string;
  trace_id?: string | null;
}

/** `ai.assistant.access.check` javobi — FE menyuni ko'rsatish/yashirish uchun ham. */
export interface AiAssistantAccessState {
  allowed: boolean;
  /** `allowed=false` sababi. */
  reason:
    | null
    | 'role_forbidden'
    | 'access_disabled'
    | 'feature_disabled'
    | 'ai_disabled';
  feature_enabled: boolean;
  daily_limit: number;
  used_today: number;
  remaining_today: number;
  /** Keyingi Toshkent yarim tuni (ISO, +05:00). */
  reset_at: string;
}

/** Javobdagi manba (har tool chaqiruvi uchun). */
export interface AiAssistantSource {
  tool: AiAssistantToolName;
  /** Davr (Toshkent sanalari) — davrsiz tool'da `null` (joriy holat). */
  period: { from: string; to: string } | null;
  /** Manbadagi yozuvlar soni (masalan tarix qatorlari, kuryerlar). */
  records: number;
  /** Natija top-N bilan qisqartirilgan bo'lsa `true`. */
  truncated: boolean;
  ok: boolean;
}

/** Xatolik kodlari (SSE `error` hodisasi). */
export type AiAssistantErrorCode =
  | 'role_forbidden'
  | 'access_disabled'
  | 'feature_disabled'
  | 'ai_disabled'
  | 'daily_limit'
  | 'assistant_usd_cap'
  | 'cap_exceeded'
  | 'busy'
  | 'conversation_not_found'
  | 'conversation_full'
  | 'invalid_message'
  | 'message_limit'
  | 'refused'
  | 'truncated'
  | 'network'
  | 'ai_error';

/**
 * ai-service → gateway → SSE hodisalari (`event: <type>`, `data: JSON`).
 * `delta` — oraliq matn (tool'dan oldingi izoh ham bo'lishi mumkin); YAKUNIY
 * matn — faqat `done.answer`.
 */
export type AiAssistantEvent =
  | {
      type: 'meta';
      conversation_id: string;
      message_id: string;
      model: string;
      max_steps: number;
    }
  | { type: 'step'; step: number }
  | { type: 'delta'; step: number; text: string }
  | {
      type: 'tool_call';
      step: number;
      id: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      step: number;
      id: string;
      tool: string;
      ok: boolean;
      records: number;
      period: { from: string; to: string } | null;
      truncated: boolean;
    }
  | {
      type: 'done';
      conversation_id: string;
      message_id: string;
      answer: string;
      stop: string;
      steps: number;
      sources: AiAssistantSource[];
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        cost_usd: number;
      };
      limits: {
        daily_limit: number;
        used_today: number;
        remaining_today: number;
      };
    }
  | {
      type: 'error';
      code: AiAssistantErrorCode;
      message: string;
      conversation_id?: string | null;
      reset_at?: string;
    };
