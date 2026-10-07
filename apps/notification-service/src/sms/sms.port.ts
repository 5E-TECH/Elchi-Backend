/**
 * SMS provayder porti (3fRbyadQ #1). Bu faylda provayderga BOG'LIQ hech narsa
 * yo'q — Eskiz, Play Mobile va boshqalar shu interfeysni amalga oshiradi.
 * Yetkazilganlik hisobotlari BIZNING `clientMessageId` bo'yicha moslanadi —
 * provayder id'siga tayanilmaydi (provayder almashsa eski DLR'lar ham topiladi).
 */

/** transactional — buyurtma holati; promo — reklama (rozilik + tungi taqiq); security — OTP. */
export type SmsMessageClass = 'transactional' | 'promo' | 'security';

export const SMS_MESSAGE_CLASSES: readonly SmsMessageClass[] = [
  'transactional',
  'promo',
  'security',
];

/** Alohida akkaunt/alfa-nom: OTP reklama bloki bilan birga o'lmasin (rkz0yBxr #7). */
export type SmsSenderProfile = 'default' | 'otp';

export const SMS_SENDER_PROFILES: readonly SmsSenderProfile[] = [
  'default',
  'otp',
];

export interface SmsSendInput {
  /** +998XXXXXXXXX (normallashtirilgan). Adapter o'z formatiga o'zi keltiradi. */
  to: string;
  text: string;
  messageClass: SmsMessageClass;
  /** BIZNING id — DLR shu bo'yicha moslanadi. */
  clientMessageId: string;
  /** DLR qaytadigan manzil (adapter qo'llab-quvvatlasa). */
  callbackUrl?: string | null;
}

export interface SmsSendResult {
  providerMessageId: string | null;
  acceptedAt: Date;
  /** Provayderning xom javobi (diagnostika uchun, qisqartiriladi). */
  raw?: unknown;
}

/** Yakuniy/oraliq yetkazish holatlari (provayderlararo yagona lug'at). */
export type SmsDlrStatus =
  | 'delivered'
  | 'transmitted'
  | 'not_delivered'
  | 'rejected'
  | 'failed'
  | 'expired';

export const SMS_DLR_FINAL_FAILURES: readonly SmsDlrStatus[] = [
  'not_delivered',
  'rejected',
  'failed',
  'expired',
];

export interface SmsDeliveryReport {
  clientMessageId: string;
  status: SmsDlrStatus;
  /** Provayderning asl status matni (masalan "DELIVRD"). */
  providerStatus: string;
  at: Date;
}

/**
 * Provayder xatosi. `retryable=true` (5xx, tarmoq, 429) — qator qayta
 * urinishga qo'yiladi; `false` (noto'g'ri raqam, rad etilgan alfa-nom) —
 * darhol terminal.
 */
export class SmsProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    readonly response?: unknown,
  ) {
    super(message);
    this.name = 'SmsProviderError';
  }
}

export interface SmsPort {
  readonly provider: string;
  send(input: SmsSendInput): Promise<SmsSendResult>;
  /** Webhook tanasidan hisobot; tanimasa null. */
  parseDeliveryReport(payload: unknown): SmsDeliveryReport | null;
  /** Provayder balansi (so'm); qo'llab-quvvatlanmasa null. */
  getBalance(): Promise<number | null>;
}
