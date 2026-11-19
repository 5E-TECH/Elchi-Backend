/**
 * «AI kalit va modellar» — gateway ↔ ai-service shartnomasi (be-brief v0.2,
 * `openapi-fragment.json` v0.2 — shakllar uchun HAQIQAT MANBAI).
 *
 * ⚠️ MAXFIYLIK: bu yerdagi hech bir tur kalit qiymatini yoki shifrmatnini
 * o'z ichiga olmaydi — faqat `hint`, `fingerprint`, `label`, aktyor, vaqt.
 */

/** RMQ buyruqlari — FAQAT `ai_config_queue` (DLX'siz) orqali. */
export const AI_CONFIG_PATTERNS = {
  GET: 'ai.config.get',
  KEY_SET: 'ai.config.key.set',
  KEY_VERIFY: 'ai.config.key.verify',
  KEY_RESTORE: 'ai.config.key.restore',
  KEY_DEACTIVATE: 'ai.config.key.deactivate',
  KEY_FORGET_PREVIOUS: 'ai.config.key.forget_previous',
  MODELS_CATALOG: 'ai.config.models.catalog',
  MODELS_ESTIMATE: 'ai.config.models.estimate',
  MODELS_UPDATE: 'ai.config.models.update',
  HISTORY: 'ai.config.history',
} as const;
export type AiConfigPattern =
  (typeof AI_CONFIG_PATTERNS)[keyof typeof AI_CONFIG_PATTERNS];

/** Yozuvchi (o'zgartiruvchi) buyruqlar — imzo, rol, ruxsat ro'yxati shart. */
export const AI_CONFIG_WRITE_PATTERNS: readonly AiConfigPattern[] = [
  AI_CONFIG_PATTERNS.KEY_SET,
  AI_CONFIG_PATTERNS.KEY_VERIFY,
  AI_CONFIG_PATTERNS.KEY_RESTORE,
  AI_CONFIG_PATTERNS.KEY_DEACTIVATE,
  AI_CONFIG_PATTERNS.KEY_FORGET_PREVIOUS,
  AI_CONFIG_PATTERNS.MODELS_UPDATE,
];

/** Xato kodlari (spec §5.3). Hech biri 401 emas. */
export const AI_CONFIG_ERROR_CODES = {
  UI_DISABLED: 'AI_CONFIG_UI_DISABLED',
  CONFLICT: 'AI_CONFIG_CONFLICT',
  INVALID: 'AI_CONFIG_INVALID',
  KEY_FORMAT: 'AI_KEY_FORMAT',
  KEY_ADMIN_KEY: 'AI_KEY_ADMIN_KEY',
  KEY_OAUTH_TOKEN: 'AI_KEY_OAUTH_TOKEN',
  KEY_SAME: 'AI_KEY_SAME',
  KEY_REJECTED: 'AI_KEY_REJECTED',
  KEY_FORBIDDEN: 'AI_KEY_FORBIDDEN',
  KEY_BAD_REQUEST: 'AI_KEY_BAD_REQUEST',
  KEY_BILLING: 'AI_KEY_BILLING',
  KEY_UPSTREAM_RATE_LIMITED: 'AI_KEY_UPSTREAM_RATE_LIMITED',
  KEY_VERIFY_UNAVAILABLE: 'AI_KEY_VERIFY_UNAVAILABLE',
  KEY_ATTEMPTS_EXCEEDED: 'AI_KEY_ATTEMPTS_EXCEEDED',
  KEY_STORAGE_UNAVAILABLE: 'AI_KEY_STORAGE_UNAVAILABLE',
  KEY_NONE: 'AI_KEY_NONE',
  KEY_NO_PREVIOUS: 'AI_KEY_NO_PREVIOUS',
  KEY_WRAP_STALE: 'AI_KEY_WRAP_STALE',
  KEY_WRAP_INVALID: 'AI_KEY_WRAP_INVALID',
  MODEL_NOT_ALLOWED: 'AI_MODEL_NOT_ALLOWED',
  MODEL_REASON_REQUIRED: 'AI_MODEL_REASON_REQUIRED',
  MODEL_CAP_RISK: 'AI_MODEL_CAP_RISK',
  MODEL_CATALOG_UNAVAILABLE: 'AI_MODEL_CATALOG_UNAVAILABLE',
  EXPIRED: 'AI_CONFIG_EXPIRED',
  UNSIGNED: 'AI_CONFIG_UNSIGNED',
  NOT_ALLOWED: 'AI_CONFIG_NOT_ALLOWED',
  STEP_UP_REQUIRED: 'AI_STEP_UP_REQUIRED',
} as const;
export type AiConfigErrorCode =
  (typeof AI_CONFIG_ERROR_CODES)[keyof typeof AI_CONFIG_ERROR_CODES];

/** Kod → HTTP status (spec §5.3). Gateway shu bilan HttpException quradi. */
export const AI_CONFIG_ERROR_STATUS: Readonly<
  Record<AiConfigErrorCode, number>
> = Object.freeze({
  AI_CONFIG_UI_DISABLED: 403,
  AI_CONFIG_CONFLICT: 409,
  AI_CONFIG_INVALID: 400,
  AI_KEY_FORMAT: 400,
  AI_KEY_ADMIN_KEY: 400,
  AI_KEY_OAUTH_TOKEN: 400,
  AI_KEY_SAME: 409,
  AI_KEY_REJECTED: 422,
  AI_KEY_FORBIDDEN: 422,
  AI_KEY_BAD_REQUEST: 422,
  AI_KEY_BILLING: 422,
  AI_KEY_UPSTREAM_RATE_LIMITED: 429,
  AI_KEY_VERIFY_UNAVAILABLE: 502,
  AI_KEY_ATTEMPTS_EXCEEDED: 429,
  AI_KEY_STORAGE_UNAVAILABLE: 503,
  AI_KEY_NONE: 404,
  AI_KEY_NO_PREVIOUS: 404,
  AI_KEY_WRAP_STALE: 409,
  AI_KEY_WRAP_INVALID: 400,
  AI_MODEL_NOT_ALLOWED: 400,
  AI_MODEL_REASON_REQUIRED: 400,
  AI_MODEL_CAP_RISK: 400,
  AI_MODEL_CATALOG_UNAVAILABLE: 503,
  AI_CONFIG_EXPIRED: 503,
  AI_CONFIG_UNSIGNED: 403,
  AI_CONFIG_NOT_ALLOWED: 403,
  AI_STEP_UP_REQUIRED: 403,
});

/** `PUBLIC_ERROR_CODES` uchun: kod → javobga chiqadigan maydonlar. */
export const AI_CONFIG_PUBLIC_ERROR_FIELDS: Readonly<
  Record<AiConfigErrorCode, readonly string[]>
> = Object.freeze({
  AI_CONFIG_UI_DISABLED: [],
  AI_CONFIG_CONFLICT: ['version'],
  AI_CONFIG_INVALID: ['field'],
  AI_KEY_FORMAT: [],
  AI_KEY_ADMIN_KEY: [],
  AI_KEY_OAUTH_TOKEN: [],
  AI_KEY_SAME: [],
  AI_KEY_REJECTED: [],
  AI_KEY_FORBIDDEN: [],
  AI_KEY_BAD_REQUEST: [],
  AI_KEY_BILLING: [],
  AI_KEY_UPSTREAM_RATE_LIMITED: ['retry_after_seconds'],
  AI_KEY_VERIFY_UNAVAILABLE: [],
  AI_KEY_ATTEMPTS_EXCEEDED: ['retry_after_seconds'],
  AI_KEY_STORAGE_UNAVAILABLE: [],
  AI_KEY_NONE: [],
  AI_KEY_NO_PREVIOUS: [],
  AI_KEY_WRAP_STALE: [],
  AI_KEY_WRAP_INVALID: [],
  AI_MODEL_NOT_ALLOWED: ['slot', 'model', 'reason'],
  AI_MODEL_REASON_REQUIRED: [],
  AI_MODEL_CAP_RISK: [],
  AI_MODEL_CATALOG_UNAVAILABLE: [],
  AI_CONFIG_EXPIRED: [],
  AI_CONFIG_UNSIGNED: [],
  AI_CONFIG_NOT_ALLOWED: [],
  AI_STEP_UP_REQUIRED: [],
});

/** RMQ javobi — handler HECH QACHON throw qilmaydi, doim ack. */
export interface AiConfigRpcError {
  statusCode: number;
  message: string;
  /** Yo'q — kutilmagan ichki xato (500, kodsiz). */
  code?: AiConfigErrorCode;
  version?: number;
  retry_after_seconds?: number;
  slot?: AiSlot;
  model?: string;
  reason?: string;
  field?: string;
}
export type AiConfigRpcResult<T> =
  { ok: true; data: T } | { ok: false; error: AiConfigRpcError };

/** 6 ta vazifa (slot). */
export const AI_SLOTS = [
  'order',
  'vision',
  'district',
  'classify',
  'finance_vision',
  'assistant',
] as const;
export type AiSlot = (typeof AI_SLOTS)[number];

export type AiKeyVerifyState =
  | 'ok'
  | 'rejected'
  | 'forbidden'
  | 'bad_request'
  | 'billing'
  | 'unavailable'
  | 'unverified';
export type AiKeyVerifyOrigin = 'verify' | 'runtime';
export type AiKeySource = 'ui' | 'env' | 'none';

export type AiDisabledReason =
  | 'staging_disabled'
  | 'no_key'
  | 'key_rejected'
  | 'key_billing'
  | 'key_forbidden'
  | 'key_unreadable'
  | 'model_unavailable'
  | 'config_stale'
  | 'client_error';

export type AiKeyLockedReason =
  | 'feature_off'
  | 'master_key_missing'
  | 'rmq_unsigned'
  | 'writer_list_empty'
  | 'not_allowed_writer'
  | 'config_stale';
export type AiModelsLockedReason = Exclude<
  AiKeyLockedReason,
  'master_key_missing'
>;

export type AiKeyWarning =
  | 'ui_key_unreadable'
  | 'ui_key_ignored_feature_off'
  | 'same_as_env'
  | 'ui_key_rejected'
  | 'ui_key_billing'
  | 'ui_key_forbidden';

export interface AiKeyCheckView {
  state: AiKeyVerifyState;
  origin: AiKeyVerifyOrigin;
  checked_at: string | null;
  error_code: AiConfigErrorCode | null;
}

export interface AiActorRef {
  id: string;
  name: string | null;
}

export interface AiStoredKeyView {
  id: string;
  label: string;
  hint: string;
  fingerprint: string;
  created_at: string;
  created_by: AiActorRef;
  verify: AiKeyCheckView;
  last_used_at: string | null;
  readable: boolean;
}

export interface AiKeyRef {
  hint: string;
  fingerprint: string;
  label?: string | null;
  source?: 'ui' | 'env';
}

export interface AiKeyWrapView {
  kid: string;
  alg: 'RSA-OAEP-256+A256GCM';
  public_key_spki: string;
}

/** Muhrlangan kalit (brauzer WebCrypto). Gateway faqat shakl/hajmni tekshiradi. */
export interface AiKeyEnvelope {
  v: 1;
  kid: string;
  alg: 'RSA-OAEP-256+A256GCM';
  ek: string;
  iv: string;
  ct: string;
}

/** «Nomi» berilmasa. */
export const AI_KEY_DEFAULT_LABEL = 'Anthropic kaliti';

/** RMQ payload'ining umumiy qismi (gateway qo'shadi, HMAC bilan imzolanadi). */
export interface AiConfigRequester {
  id: string;
  roles: string[];
  name?: string | null;
}
export interface AiConfigRpcBase {
  requester: AiConfigRequester;
  /** Gateway `Date.now()` — vaqt oynalari (be-brief §6.2 deadline). */
  sent_at: number;
  /** Gateway step-up tokenini tekshirib iste'mol qilgan (BE-5). */
  step_up?: boolean;
}
