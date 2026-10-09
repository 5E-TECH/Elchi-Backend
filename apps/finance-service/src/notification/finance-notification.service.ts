import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  OutboxService,
  Source_type,
  findNotificationType,
  renderNotificationGroupKey,
} from '@app/common';

/**
 * HODISA → BILDIRISHNOMA (ePpLHPX2) — finance-service.
 *
 * Naqsh order-service pilotidan (OA16fdSq, `order-notification.service.ts`)
 * va `libs/common/src/outbox/README.md` yo'riqnomasidan:
 *
 *   • `finance.payment_received` — to'lov o'tdi. Nishon — puli kelgan/ketgan
 *     tomon: HQ marketga to'laganda (`paymentsToMarket`) va kuryer pulini
 *     marketga o'tkazganda (click_to_market) — MARKET; kuryer kassaga pul
 *     topshirganda (`paymentsFromCourier`) — KURYER (topshirgani qabul
 *     qilinganining tasdig'i).
 *   • `finance.balance_topup` — balans qo'lda to'ldirildi (BeePost
 *     `notifyBalanceTopup` analogi: admin market balansini to'ldiradi).
 *     Elchi'da bu — market/kuryer kassasiga qo'lda KIRIM (MANUAL_INCOME,
 *     `updateBalance`). Nishon — kassa egasi.
 *
 * ⚠️ FAQAT OUTBOX. To'g'ridan-to'g'ri rmqSend / client.send TAQIQ: pul
 * tranzaksiyasi rollback bo'lsa ham xabar ketib qolardi ("to'lov o'tdi" —
 * aslida o'tmagan). Outbox qatori pul yozuvlari bilan BITTA tranzaksiyada.
 *
 * ⚠️ FAIL-OPEN. notification-service ishlamasa pul amali baribir o'tadi:
 * tranzaksiyada faqat `outbox_events` ga INSERT, yetkazishni OutboxPublisher
 * keyin qiladi (`fireAndForgetPatterns` — javob kutilmaydi). Payload
 * qurishdagi kutilmagan xato ham pul amalini yiqitmaydi (faqat WARN).
 * Tranzaksiya ichidagi DB xatosi esa qayta otiladi — Postgres tranzaksiyasi
 * baribir buzilgan, chaqiruvchi rollback qilsin (order-service naqshi).
 *
 * PII: in_app `body` — faqat raqam + summa (telefon/manzil/izoh YO'Q;
 * to'lov izohi erkin matn, unga hech qachon kirmaydi).
 */

export const NOTIFICATION_OUTBOX_TARGET = 'NOTIFICATION';
export const NOTIFICATION_DISPATCH_PATTERN = 'notification.dispatch';

/** Shu servis yuboradigan turlar — kalitlar `NOTIFICATION_TYPES` katalogida. */
export const FINANCE_NOTIFICATION_TYPES = [
  'finance.payment_received',
  'finance.balance_topup',
] as const;

export type FinanceNotificationType =
  (typeof FINANCE_NOTIFICATION_TYPES)[number];

/** Market / kuryerning o'z kassasi sahifasi (frontend `MyCashboxPage`). */
export const FINANCE_SELF_CASHBOX_LINK = '/cash-box';

/**
 * `market_payment` — marketga pul o'tkazildi (HQ to'lovi yoki kuryerning
 * marketga o'tkazmasi); `courier_payment` — kuryer topshirgan pul kassaga
 * qabul qilindi.
 */
export type FinancePaymentKind = 'market_payment' | 'courier_payment';

export interface FinanceNotificationPayload {
  type: FinanceNotificationType;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  link: string;
  recipient_ids: string[];
  group_key?: string;
  channels: string[];
}

export interface PaymentReceivedInput {
  kind: FinancePaymentKind;
  /** Puli kelgan/ketgan tomon (market yoki kuryer user id si). */
  recipient_id: string | number | null | undefined;
  /** Qabul qiluvchi kassasidagi tarix qatori id si (to'lov raqami). */
  payment_id: string | number | null | undefined;
  amount: number | string | null | undefined;
  payment_method?: string | null;
}

export interface BalanceTopupInput {
  cashbox_type: Cashbox_type | string | null | undefined;
  operation_type: Operation_type | string | null | undefined;
  source_type: Source_type | string | null | undefined;
  /** Kassa egasi (FOR_MARKET / FOR_COURIER kassasining `user_id` si). */
  recipient_id: string | number | null | undefined;
  history_id: string | number | null | undefined;
  amount: number | string | null | undefined;
  balance_after?: number | string | null;
}

const isId = (value: unknown): value is string | number =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^\d+$/.test(String(value)) &&
  !/^0+$/.test(String(value));

const formatMoney = (value: unknown) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount)
    ? `${Math.round(amount)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`
    : '';
};

const positiveAmount = (value: unknown): number | null => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

/**
 * `finance.payment_received` payload'i. Qabul qiluvchi yoki summa yaroqsiz
 * bo'lsa — `null` (bildirishnoma yo'q, pul amaliga ta'sir yo'q).
 */
export function buildPaymentReceivedPayload(
  input: PaymentReceivedInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.payment_received';
  const entry = findNotificationType(type);
  const amount = positiveAmount(input.amount);
  if (!entry || !isId(input.recipient_id) || amount === null) return null;

  const paymentId = isId(input.payment_id) ? String(input.payment_id) : null;
  const data: Record<string, unknown> = {
    kind: input.kind,
    amount,
    ...(paymentId ? { payment_id: paymentId } : {}),
    ...(input.payment_method ? { payment_method: input.payment_method } : {}),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  const ref = paymentId ? ` (to'lov #${paymentId})` : '';
  const money = formatMoney(amount);

  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: "To'lov qabul qilindi",
    // in_app: faqat raqam + summa (PII yo'q).
    body:
      input.kind === 'market_payment'
        ? `Sizga ${money} to'landi${ref}.`
        : `Siz topshirgan ${money} kassaga qabul qilindi${ref}.`,
    data,
    link: FINANCE_SELF_CASHBOX_LINK,
    recipient_ids: [String(input.recipient_id)],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
  };
}

/**
 * Qo'lda balans to'ldirishmi: market/kuryer kassasiga MANUAL_INCOME kirimi.
 * Tizim oyoqlari (sotuv, bekor qilish, tuzatish) va MAIN/BRANCH kassasini
 * to'ldirish (`fillTheCashbox`) — bu hodisa EMAS.
 */
export function isBalanceTopup(input: BalanceTopupInput): boolean {
  return (
    input.operation_type === Operation_type.INCOME &&
    input.source_type === Source_type.MANUAL_INCOME &&
    (input.cashbox_type === Cashbox_type.FOR_MARKET ||
      input.cashbox_type === Cashbox_type.FOR_COURIER)
  );
}

/** `finance.balance_topup` payload'i (BeePost notifyBalanceTopup matni asosida). */
export function buildBalanceTopupPayload(
  input: BalanceTopupInput,
): FinanceNotificationPayload | null {
  const type: FinanceNotificationType = 'finance.balance_topup';
  const entry = findNotificationType(type);
  const amount = positiveAmount(input.amount);
  if (
    !entry ||
    !isBalanceTopup(input) ||
    !isId(input.recipient_id) ||
    amount === null
  ) {
    return null;
  }

  const historyId = isId(input.history_id) ? String(input.history_id) : null;
  const balance = Number(input.balance_after);
  const hasBalance =
    input.balance_after !== null &&
    input.balance_after !== undefined &&
    Number.isFinite(balance);
  const data: Record<string, unknown> = {
    amount,
    cashbox_type: input.cashbox_type,
    ...(historyId ? { history_id: historyId } : {}),
    ...(hasBalance ? { balance_after: balance } : {}),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);

  return {
    type,
    category: entry.category,
    priority: entry.priority,
    title: "Balans to'ldirildi",
    // in_app: summa + joriy balans (holat) — izoh/PII yo'q.
    body: `Balansingiz ${formatMoney(amount)} ga to'ldirildi.${
      hasBalance ? ` Joriy balans: ${formatMoney(balance)}.` : ''
    }`,
    data,
    link: FINANCE_SELF_CASHBOX_LINK,
    recipient_ids: [String(input.recipient_id)],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
  };
}

@Injectable()
export class FinanceNotificationService {
  private readonly logger = new Logger(FinanceNotificationService.name);

  constructor(private readonly outbox: OutboxService) {}

  /**
   * To'lov o'tdi. `manager` — pul yozuvlari turgan tranzaksiya: outbox qatori
   * ham AYNAN shunda (rollback bo'lsa bildirishnoma ham yo'q).
   */
  async paymentReceived(
    input: PaymentReceivedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueueSafely(
      'finance.payment_received',
      () => buildPaymentReceivedPayload(input),
      manager,
    );
  }

  /** Balans qo'lda to'ldirildi (faqat market/kuryer kassasiga MANUAL_INCOME). */
  async balanceTopup(
    input: BalanceTopupInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueueSafely(
      'finance.balance_topup',
      // `buildBalanceTopupPayload` o'zi `isBalanceTopup` ni tekshiradi —
      // boshqa oyoqlar uchun `null` (bildirishnoma yo'q).
      () => buildBalanceTopupPayload(input),
      manager,
    );
  }

  /**
   * Kirish ma'lumotiga HAR qanday murojaat (`build`) try ichida — payload
   * qurishdagi kutilmagan xato pul amalini YIQITMAYDI (fail-open).
   */
  private async enqueueSafely(
    type: FinanceNotificationType,
    build: () => FinanceNotificationPayload | null,
    manager: EntityManager | undefined,
  ): Promise<void> {
    const inTransaction = Boolean(manager?.queryRunner?.isTransactionActive);

    let payload: FinanceNotificationPayload | null = null;
    try {
      payload = build();
    } catch (err) {
      this.logger.warn(
        `finance notification payload (${type}) qurilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return;
    }
    if (!payload) return;
    const ref = `recipient=${payload.recipient_ids.join(',')}`;

    try {
      await this.outbox.enqueue(
        NOTIFICATION_OUTBOX_TARGET,
        NOTIFICATION_DISPATCH_PATTERN,
        payload,
        manager ? { manager } : {},
      );
    } catch (err) {
      // Tranzaksiya ichida DB xatosi — Postgres tranzaksiyasi baribir
      // buzilgan, chaqiruvchi rollback qilsin. Tranzaksiyasiz yo'lda esa
      // bildirishnoma pul amalini yiqitmaydi (fail-open).
      if (inTransaction) throw err;
      this.logger.warn(
        `finance notification (${type}, ${ref}) outbox'ga yozilmadi: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }
}
