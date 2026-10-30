import { randomInt } from 'node:crypto';
import {
  type PasswordPolicyContext,
  isPasswordPolicyCompliant,
} from './password-policy';

/**
 * (aidsxJ2H, 2026-10-26) Foydalanuvchi yaratishda parolni TIZIM yaratadi va
 * SMS qilib yuboradi (`password_mode: 'generate_sms'`).
 *
 *  - 12 belgi, `crypto.randomInt` (kriptografik tasodif);
 *  - chalkash belgilarsiz: `0 O o 1 l I i` yo'q — SMS'dan qo'lda terishda
 *    adashilmasin; faqat lotin harf + raqam (GSM-7 — SMS 1 bo'lak);
 *  - kamida bitta katta harf, kichik harf va raqam; parol siyosatiga
 *    (`password-policy.ts`: xodim 10 belgi, oddiy/ketma-ket/takror yo'q)
 *    DOIM mos — mos kelmasa qayta yaratiladi.
 *
 * Parol faqat xotirada yashaydi: hash'lanadi, SMS navbatiga beriladi va
 * tashlanadi — DB'ga, logga, javobga, faoliyat jurnaliga YOZILMAYDI.
 */
export const TEMP_PASSWORD_LENGTH = 12;

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
export const TEMP_PASSWORD_ALPHABET = `${UPPER}${LOWER}${DIGITS}`;

/** Yaratish DTO'laridagi parol rejimi. */
export const PASSWORD_MODES = ['generate_sms', 'manual'] as const;
export type PasswordMode = (typeof PASSWORD_MODES)[number];

/**
 * Vaqtinchalik parol SMS'ining yetkazish holati (FE «SMS yuborildi /
 * Yetkazildi» qadamlari): `pending` — navbatda (provayderga hali
 * berilmagan), `sent` — provayder qabul qildi, `delivered` — provayder
 * hisoboti: yetkazildi, `failed` — yuborilmadi (sababi `failure_reason`).
 */
export const PASSWORD_SMS_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'failed',
] as const;
export type PasswordSmsStatus = (typeof PASSWORD_SMS_STATUSES)[number];

/** identity → notification: vaqtinchalik parolni SMS navbatiga qo'yish. */
export const NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN =
  'notification.sms.send_temp_password';
/** identity → notification: `client_message_id` lar bo'yicha yetkazish holati. */
export const NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN =
  'notification.sms.delivery_status';

/** SMS shabloni kodi (notification `sms_templates`, «security» sinfi). */
export const TEMP_PASSWORD_SMS_TEMPLATE_CODE = 'user.temp_password';

/** Qayta yuborish: oxirgi SMS'dan keyin shuncha soniya o'tishi kerak. */
export const PASSWORD_SMS_RESEND_COOLDOWN_SECONDS = 60;
/** Qayta yuborish: bitta foydalanuvchiga bir Toshkent kunida ko'pi bilan. */
export const PASSWORD_SMS_RESEND_DAILY_LIMIT = 5;

const PASSWORD_SMS_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  sms_disabled: "SMS yuborish hozir o'chirilgan",
  daily_cap_exceeded: 'Bugungi SMS limiti tugagan',
  fanout_exceeded: 'SMS limiti tugagan',
  provider_not_configured: 'SMS provayder sozlanmagan',
  invalid_phone: "Telefon raqami noto'g'ri — SMS yuborilmadi",
  template_error: "SMS shabloni noto'g'ri sozlangan",
  notification_unavailable: 'SMS xizmati javob bermadi',
  provider_rejected:
    "SMS provayder xabarni rad etdi (balans yoki shablon tasdig'ini tekshiring)",
  provider_unavailable: "SMS provayderiga ulanib bo'lmadi",
  not_delivered: 'SMS telefonga yetkazilmadi',
  staging_blocked:
    'Test muhitida bu raqamga SMS yuborilmaydi (STAGING_SMS_ALLOWLIST)',
  cancelled: 'SMS bekor qilindi',
};

/** `failure_reason` mashina kodi → foydalanuvchiga o'zbekcha sabab. */
export function passwordSmsFailureMessage(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  return (
    PASSWORD_SMS_FAILURE_MESSAGES[reason] ??
    "SMS yuborilmadi — qayta urinib ko'ring"
  );
}

const pick = (chars: string): string => chars[randomInt(0, chars.length)];

/** Fisher–Yates (`randomInt`) — majburiy belgilar doim boshida turmasin. */
function shuffle(chars: string[]): string[] {
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(0, index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars;
}

/**
 * Siyosatga mos 12 belgili vaqtinchalik parol. `context` — egasining roli
 * va telefoni (siyosat tekshiruvi uchun).
 */
export function generateTempPassword(
  context: PasswordPolicyContext = {},
): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
    while (chars.length < TEMP_PASSWORD_LENGTH) {
      chars.push(pick(TEMP_PASSWORD_ALPHABET));
    }
    const candidate = shuffle(chars).join('');
    if (isPasswordPolicyCompliant(candidate, context)) return candidate;
  }
  // 62^12 fazoda 50 marta ketma-ket siyosatga mos kelmaslik amalda imkonsiz.
  throw new Error('Vaqtinchalik parol yaratilmadi');
}
