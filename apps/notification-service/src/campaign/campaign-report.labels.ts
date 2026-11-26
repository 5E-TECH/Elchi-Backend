import { maskPhonesForLog } from '@app/common';
import type { CampaignReportKind } from './campaign-report-export.entity';

/**
 * «Yetkazilmaganlar» hisobotining o'zbekcha yorliqlari — frontend'dagi hisobot
 * oynasi bilan bir xil (`notifications.json`: dispatch.channel / delivery /
 * reason, campaign.role; kod xaritasi — `notification-dispatch/reasons.ts`).
 * Ro'yxatda yo'q kod — xom qiymat (yangi kod eksportdan yo'qolmasin).
 */

const CHANNELS = new Map<string, string>([
  ['in_app', 'Ilova ichida'],
  ['realtime', 'Darhol'],
  ['telegram', 'Telegram'],
  ['sms', 'SMS'],
  ['push', 'Push'],
  ['email', 'Email'],
]);

const ROLES = new Map<string, string>([
  ['superadmin', 'Superadmin'],
  ['admin', 'Admin'],
  ['manager', 'Menejer'],
  ['registrator', 'Registrator'],
  ['courier', 'Kuryer'],
  ['logist', 'Logist'],
  ['market', 'Market'],
  ['market_operator', 'Market operatori'],
  ['operator', 'Operator'],
  ['branch', 'Filial'],
  ['investor', 'Investor'],
  ['customer', 'Mijoz'],
]);

/** Yetkazilmagan kanal xabarining guruhi (ekrandagi belgi bilan bir xil). */
export type UndeliveredBucket = 'failed' | 'skipped' | 'no_provider';

export const BUCKET_LABELS: Readonly<Record<UndeliveredBucket, string>> = {
  failed: 'Xato',
  skipped: "O'tkazib yuborildi",
  no_provider: 'Provayder ulanmagan',
};

const STATUS_BUCKETS = new Map<string, UndeliveredBucket>([
  ['failed', 'failed'],
  // SMS operator hisoboti (DLR) — yakuniy xatolar.
  ['not_delivered', 'failed'],
  ['rejected', 'failed'],
  ['expired', 'failed'],
  ['no_provider', 'no_provider'],
  ['skipped', 'skipped'],
  ['not_eligible', 'skipped'],
  ['no_subscription', 'skipped'],
  ['blocked', 'skipped'],
]);

/** Sabab kodi → matn. */
const REASONS = new Map<string, string>([
  ['muted', "Bildirishnomani o'chirgan"],
  ['no_telegram_id', 'Telegram ulanmagan'],
  ['not_private_chat', 'Telegram ulanmagan'],
  ['bot_blocked', 'Botni bloklagan'],
  ['telegram_target_missing', 'Telegram guruhi ulanmagan'],
  ['no_telegram_group', 'Telegram guruhi ulanmagan'],
  ['no_phone', "Telefon raqami yo'q"],
  ['sms_disabled', "SMS o'chirilgan"],
  ['provider_not_configured', 'Provayder ulanmagan'],
  ['daily_cap_exceeded', 'Kunlik SMS chegarasi tugagan'],
  ['duplicate', 'Takroriy xabar'],
  ['push_disabled', "Push o'chirilgan"],
  ['online', 'Ilova ochiq edi'],
  ['quiet_hours', 'Tungi tinch vaqt'],
  ['no_subscription', "Push obunasi yo'q"],
  ['subscription_expired', 'Push obunasi eskirgan'],
  ['payload_too_large', 'Xabar push uchun juda katta'],
  ['rate_limited', "Push xizmati so'rovlarni chekladi"],
  ['push_rejected', 'Push xizmati rad etdi'],
  ['push_service_error', 'Push xizmatida xatolik'],
  ['network_error', 'Tarmoq xatosi'],
  ['push_failed', 'Push yetkazilmadi'],
  ['no_consent', "Reklama SMS'ga rozilik yo'q"],
  ['fanout_exceeded', 'SMS auditoriya chegarasidan oshdi'],
  ['opt_out_not_configured', 'Bekor qilish havolasi sozlanmagan'],
  ['campaign_cancelled', 'Kampaniya bekor qilindi'],
]);

/** Kod yo'q — holatning o'zi sabab. */
const STATUS_REASONS = new Map<string, string>([
  ['no_provider', 'Provayder ulanmagan'],
  ['no_subscription', "Push obunasi yo'q"],
  ['not_eligible', 'Kanal ulanmagan'],
  ['blocked', 'SMS chegarasi'],
  ['not_delivered', 'SMS yetkazilmadi'],
  ['rejected', 'Operator rad etdi'],
  ['expired', 'Operator muddatida yetkaza olmadi'],
]);

/** `failed`, sababi yozilmagan — kanal bo'yicha umumiy matn. */
const FAILED_REASONS = new Map<string, string>([
  ['telegram', 'Telegram xatosi'],
  ['sms', 'SMS yetkazilmadi'],
  ['push', 'Push yetkazilmadi'],
]);

/** Operator javobi (`DLR: UNDELIV`) — holat matni yoniga qo'shiladi. */
const DLR_RAW_RE = /^DLR:/i;

export const channelLabel = (code: string): string =>
  CHANNELS.get(code) ?? code;

/** Rol (vergulli ro'yxat bo'lishi mumkin) → yorliq; bo'sh — ''. */
export const roleLabel = (raw: string | null | undefined): string =>
  (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ROLES.get(part.toLowerCase()) ?? part)
    .join(', ');

/**
 * Holat guruhi. Noma'lum holat ham guruhsiz qolmaydi (jami to'g'ri chiqsin):
 * SMS kampaniyasi ro'yxati faqat `failed` qatorlar — xato; bildirishnomada —
 * o'tkazib yuborildi (`UNDELIVERED_STATUSES` ga qo'shilgan yangi holat).
 */
export const statusBucket = (
  kind: CampaignReportKind,
  status: string,
): UndeliveredBucket =>
  STATUS_BUCKETS.get(status) ?? (kind === 'sms' ? 'failed' : 'skipped');

export const statusLabel = (status: string): string => {
  const bucket = STATUS_BUCKETS.get(status);
  return bucket ? BUCKET_LABELS[bucket] : status;
};

/**
 * Sabab: kod xaritasi → xom sabab (noma'lum kod / provayder matni) → holat
 * matni. Aytadigan sabab yo'q — '' (katakda «—»).
 */
export const reasonLabel = (failure: {
  channel: string;
  status: string;
  reason: string | null;
  reason_code: string | null;
}): string => {
  const code = (failure.reason_code ?? '').trim();
  const raw = (failure.reason ?? '').trim();
  const known = REASONS.get(code) ?? REASONS.get(raw);
  if (known) return known;
  const general =
    STATUS_REASONS.get(failure.status) ??
    (failure.status === 'failed'
      ? (FAILED_REASONS.get(failure.channel) ?? 'Yetkazilmadi')
      : '');
  if (raw) {
    // Provayder xom matnida raqam bo'lsa ham — maskalangan.
    const masked = maskPhonesForLog(raw);
    return general && DLR_RAW_RE.test(raw) ? `${general} (${masked})` : masked;
  }
  return code || general;
};
