import {
  AI_CONFIG_ERROR_CODES,
  RMQ_REQUESTER_SIG_HEADER,
  rmqCmdOf,
  verifyRmqRequester,
  type AiConfigErrorCode,
  type AiConfigRequester,
  type AiKeyLockedReason,
  type AiModelsLockedReason,
} from '@app/common';

/**
 * `ai.config.*` yozuv tekshiruvi (be-brief D1) — SOF va HECH QACHON throw
 * qilmaydi: natija `{ok:false, code}` bo'lib qaytadi, handler uni ack bilan
 * javob qiladi (xabar DLQ'ga tushmaydi).
 *
 * Tartib: imzo (kind `gateway`, `RMQ_REQUESTER_SIG_MODE` dan QAT'I NAZAR) →
 * navbat (`ai_config_queue` dan boshqa navbatdan kelgan yozuv rad) → rol
 * `superadmin` → `AI_CONFIG_UI_ENABLED` → `AI_CONFIG_WRITER_IDS` → step-up.
 *
 * ⚠️ Advisor'ning throw qiladigan `assertSuperadmin` i bu yerda
 * ishlatilmaydi.
 */
export interface AiConfigAccessSettings {
  appEnv: string;
  uiEnabled: boolean;
  /** Sir (≥ 32 belgi) — yo'q bo'lsa yozish o'chiq (`rmq_unsigned`). */
  sigSecret: string | undefined;
  /** `ai_config_queue` nomi. */
  configQueue: string;
  writerIds: readonly string[];
  stepUpRequired: boolean;
  masterKeyConfigured: boolean;
}

export interface AiConfigRpcContextLike {
  getPattern?: () => unknown;
  getMessage?: () => unknown;
}

interface AmqpMessageLike {
  fields?: { routingKey?: unknown };
  properties?: { headers?: Record<string, unknown> };
}

export type AiConfigWriteCheck =
  | { ok: true; requester: AiConfigRequester }
  | { ok: false; code: AiConfigErrorCode };

export function parseWriterIds(raw: unknown): string[] {
  return (typeof raw === 'string' ? raw : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function requesterOf(data: unknown): AiConfigRequester | null {
  if (!data || typeof data !== 'object') return null;
  const r = (data as { requester?: unknown }).requester;
  if (!r || typeof r !== 'object') return null;
  const { id, roles, name } = r as Record<string, unknown>;
  if ((typeof id !== 'string' && typeof id !== 'number') || id === '')
    return null;
  if (!Array.isArray(roles)) return null;
  return {
    id: String(id),
    roles: roles.filter((x): x is string => typeof x === 'string'),
    name: typeof name === 'string' ? name.slice(0, 120) : null,
  };
}

const isSuperadmin = (r: AiConfigRequester) =>
  r.roles.map((x) => x.toLowerCase()).includes('superadmin');

/**
 * Yozuvchi (writer) ruxsati: staging/development'da ro'yxat bo'sh bo'lsa —
 * hech kim (`writer_list_empty`); prod'da bo'sh ro'yxat = har superadmin.
 */
function writerLock(
  s: AiConfigAccessSettings,
  requesterId: string,
): 'writer_list_empty' | 'not_allowed_writer' | null {
  if (s.writerIds.length === 0) {
    return s.appEnv === 'production' ? null : 'writer_list_empty';
  }
  return s.writerIds.includes(requesterId) ? null : 'not_allowed_writer';
}

export function checkConfigWrite(
  ctx: AiConfigRpcContextLike,
  data: unknown,
  s: AiConfigAccessSettings,
  opts: { stepUp: boolean; now?: number },
): AiConfigWriteCheck {
  const no = (code: AiConfigErrorCode): AiConfigWriteCheck => ({
    ok: false,
    code,
  });
  if (!s.sigSecret) return no(AI_CONFIG_ERROR_CODES.UNSIGNED);

  let msg: AmqpMessageLike = {};
  let cmd = '';
  try {
    msg = ctx.getMessage?.() ?? {};
    cmd = rmqCmdOf(ctx.getPattern?.());
  } catch {
    return no(AI_CONFIG_ERROR_CODES.UNSIGNED);
  }
  const header = msg.properties?.headers?.[RMQ_REQUESTER_SIG_HEADER];
  const verdict = verifyRmqRequester({
    cmd,
    data,
    header: typeof header === 'string' ? header : undefined,
    secret: s.sigSecret,
    now: opts.now,
  });
  if (!verdict.ok || verdict.source !== 'gateway')
    return no(AI_CONFIG_ERROR_CODES.UNSIGNED);

  // Kalit xabari hech qachon DLX'li `ai_queue` da turmasin.
  if (msg.fields?.routingKey !== s.configQueue)
    return no(AI_CONFIG_ERROR_CODES.UNSIGNED);

  const requester = requesterOf(data);
  if (!requester || !isSuperadmin(requester))
    return no(AI_CONFIG_ERROR_CODES.NOT_ALLOWED);
  if (!s.uiEnabled) return no(AI_CONFIG_ERROR_CODES.UI_DISABLED);
  if (writerLock(s, requester.id)) return no(AI_CONFIG_ERROR_CODES.NOT_ALLOWED);
  if (
    opts.stepUp &&
    s.stepUpRequired &&
    (data as { step_up?: unknown }).step_up !== true
  ) {
    return no(AI_CONFIG_ERROR_CODES.STEP_UP_REQUIRED);
  }
  return { ok: true, requester };
}

export interface AiConfigPermissions {
  key: boolean;
  models: boolean;
  step_up_required: boolean;
  key_locked_reason: AiKeyLockedReason | null;
  models_locked_reason: AiModelsLockedReason | null;
}

/** GET /ai/config: ruxsatlar va qulf sababi (birinchi sabab). */
export function configPermissions(
  s: AiConfigAccessSettings,
  requesterId: string | null,
  configStale: boolean,
): AiConfigPermissions {
  const common: AiModelsLockedReason | null = !s.uiEnabled
    ? 'feature_off'
    : !s.sigSecret
      ? 'rmq_unsigned'
      : requesterId === null
        ? 'not_allowed_writer'
        : (writerLock(s, requesterId) ?? (configStale ? 'config_stale' : null));
  const keyReason: AiKeyLockedReason | null =
    common === 'feature_off'
      ? common
      : !s.masterKeyConfigured
        ? 'master_key_missing'
        : common;
  return {
    key: keyReason === null,
    models: common === null,
    step_up_required: s.stepUpRequired,
    key_locked_reason: keyReason,
    models_locked_reason: common,
  };
}
