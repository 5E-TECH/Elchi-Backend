import { normalizeUzPhone } from '../ai-text/phone';

/**
 * (staging-safe) STAGING (test) serveri prod ma'lumotlari NUSXASI bilan
 * ishlaydi — u yerdan haqiqiy mijoz/xodimga SMS, Telegram yoki push KETMASLIGI
 * shart. Bu modul chiquvchi kanallarning ENG PASTKI (transport) qatlami
 * chaqiradigan yagona qaror nuqtasi:
 *
 *  - SMS        → `EskizAdapter.send` / `PlayMobileAdapter.send`;
 *  - Telegram   → `callTelegramApi` / `callTelegramApiMultipart`
 *                 (bot-transport.service.ts — Bot API bilan yagona aloqa nuqtasi);
 *  - Web push   → `WebPushService.sendToSubscriptions`;
 *  - AI         → `ClaudeService` (STAGING_AI_ENABLED) + `AiBudgetService`
 *                 (STAGING_AI_DAILY_USD_CAP).
 *
 * Qoidalar:
 *  - `APP_ENV` berilmagan / bo'sh → `production`: prod xatti-harakati
 *    O'ZGARMAYDI (hech narsa tekshirilmaydi).
 *  - `APP_ENV=staging` → har kanal faqat o'z allowlist'idagi qabul
 *    qiluvchiga yuboradi. Allowlist BO'SH bo'lsa — FAIL-CLOSED: shu kanalda
 *    hech narsa yuborilmaydi.
 *  - Noma'lum `APP_ENV` qiymati (masalan `stagin`) — fail-closed, staging
 *    deb olinadi. Servislarda Joi uni boot'da baribir rad etadi; bu himoya
 *    Joi'siz skriptlar (telegram-setup) uchun.
 *
 * Qiymatlar `process.env` dan HAR chaqiruvda o'qiladi (ro'yxatlar qisqa) —
 * ConfigModule validatsiyadan keyin sukutlarni ham `process.env` ga yozadi.
 */
export const APP_ENVS = ['production', 'staging', 'development'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

type EnvLike = Record<string, string | undefined>;

export function resolveAppEnv(env: EnvLike = process.env): AppEnv {
  const raw = String(env.APP_ENV ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return 'production';
  return (APP_ENVS as readonly string[]).includes(raw)
    ? (raw as AppEnv)
    : 'staging';
}

export const isStagingEnv = (env: EnvLike = process.env): boolean =>
  resolveAppEnv(env) === 'staging';

export type StagingChannel = 'sms' | 'telegram' | 'push';

export const STAGING_ALLOWLIST_ENV: Readonly<Record<StagingChannel, string>> = {
  sms: 'STAGING_SMS_ALLOWLIST',
  telegram: 'STAGING_TELEGRAM_CHAT_ALLOWLIST',
  push: 'STAGING_PUSH_USER_ALLOWLIST',
};

/** Allowlist'dagi va yuborishdagi qiymatni BIR xil ko'rinishga keltiradi. */
export function normalizeStagingTarget(
  channel: StagingChannel,
  value: unknown,
): string | null {
  if (channel === 'sms') return normalizeUzPhone(value);
  const text =
    typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (/^-?\d{1,20}$/.test(text)) {
    // "0025" va "25" — bitta id (bigint ustunlar matn bo'lib keladi).
    return text.replace(/^(-?)0+(?=\d)/, '$1');
  }
  // Telegram kanal/guruhi `@username` ko'rinishida ham bo'lishi mumkin.
  if (channel === 'telegram' && /^@[A-Za-z0-9_]{4,32}$/.test(text)) {
    return text.toLowerCase();
  }
  return null;
}

/**
 * Vergul / nuqtali vergul / yangi qator bilan ajratilgan ro'yxat → elementlar.
 * Bo'shliq AJRATUVCHI EMAS — telefon `90 123 45 67` ko'rinishida yozilishi mumkin.
 */
export function splitAllowlist(raw: unknown): string[] {
  const text =
    typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  return text
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Yaroqsiz elementlar (Joi boot'da shular bilan rad etadi). */
export function invalidAllowlistEntries(
  channel: StagingChannel,
  raw: unknown,
): string[] {
  return splitAllowlist(raw).filter(
    (part) => normalizeStagingTarget(channel, part) === null,
  );
}

export function parseStagingAllowlist(
  channel: StagingChannel,
  env: EnvLike = process.env,
): Set<string> {
  const out = new Set<string>();
  for (const part of splitAllowlist(env[STAGING_ALLOWLIST_ENV[channel]])) {
    const normalized = normalizeStagingTarget(channel, part);
    if (normalized) out.add(normalized);
  }
  return out;
}

/** Log/xato matni uchun: to'liq raqam/id chiqmaydi (oxirgi 4 belgi). */
export function maskStagingTarget(value: unknown): string {
  const raw =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
      ? String(value)
      : '';
  const text = raw.replace(/[^0-9A-Za-z@_-]/g, '');
  return text.length > 4 ? `***${text.slice(-4)}` : '***';
}

/** Xato/sabab matnlari shu prefiks bilan boshlanadi (qidirish oson). */
export const STAGING_BLOCKED_PREFIX = 'staging_blocked';

export interface StagingOutboundDecision {
  allowed: boolean;
  /** Bloklangan bo'lsa — aniq sabab (PII'siz). */
  reason: string | null;
}

/**
 * Bitta qabul qiluvchi uchun qaror. production/development — doim ruxsat.
 */
export function checkStagingOutbound(
  channel: StagingChannel,
  target: unknown,
  env: EnvLike = process.env,
): StagingOutboundDecision {
  if (!isStagingEnv(env)) return { allowed: true, reason: null };
  const envName = STAGING_ALLOWLIST_ENV[channel];
  const allowlist = parseStagingAllowlist(channel, env);
  if (allowlist.size === 0) {
    return {
      allowed: false,
      reason: `${STAGING_BLOCKED_PREFIX}: APP_ENV=staging va ${envName} bo'sh — ${channel} yuborilmadi (skipped)`,
    };
  }
  const normalized = normalizeStagingTarget(channel, target);
  if (normalized !== null && allowlist.has(normalized)) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: `${STAGING_BLOCKED_PREFIX}: qabul qiluvchi ${maskStagingTarget(target)} ${envName} da yo'q — ${channel} yuborilmadi (skipped)`,
  };
}

const TRUTHY = /^(true|1|yes|on)$/i;

/** AI (Anthropic) staging'da faqat STAGING_AI_ENABLED=true bo'lsa. */
export function isAiAllowedInEnv(env: EnvLike = process.env): boolean {
  if (!isStagingEnv(env)) return true;
  return TRUTHY.test(String(env.STAGING_AI_ENABLED ?? '').trim());
}

/** Staging'da AI yoqilgan bo'lsa ham kunlik shift shundan oshmaydi (USD). */
export const STAGING_AI_DEFAULT_DAILY_USD_CAP = 2;

/**
 * Staging'dagi qattiq kunlik AI shifti (USD). production/development — `null`
 * (mavjud AI_DAILY_USD_CAP o'zgarmaydi).
 */
export function stagingAiDailyUsdCap(
  env: EnvLike = process.env,
): number | null {
  if (!isStagingEnv(env)) return null;
  const value = Number(String(env.STAGING_AI_DAILY_USD_CAP ?? '').trim());
  return Number.isFinite(value) && value > 0
    ? value
    : STAGING_AI_DEFAULT_DAILY_USD_CAP;
}
