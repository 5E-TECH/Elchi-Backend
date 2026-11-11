import type { EntityManager } from 'typeorm';
import {
  formatOrderNumber,
  NotificationCategory,
  NotificationPriority,
  OutboxService,
} from '@app/common';

/** Bildirishnoma yadrosiga (notification-service) outbox hodisasi. */
const DISPATCH_PATTERN = 'notification.dispatch';

export type ExtraCostNotificationType =
  | 'order.extra_cost_requested'
  | 'order.extra_cost_reminder'
  | 'order.extra_cost_auto_approved'
  // (GykuOz8f) so'rov yozgan kuryer / menejerga — market qarori yoki yopilish.
  | 'order.extra_cost_approved'
  | 'order.extra_cost_rejected'
  | 'order.extra_cost_voided';

/** "250 000 so'm" — `numeric` satr ham to'g'ri. */
export function formatSom(value: unknown): string {
  const amount = Number(
    typeof value === 'string' || typeof value === 'number' ? value : 0,
  );
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return `${String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`;
}

/**
 * (DuST9k8j / 1tnpaIqd) Qo'shimcha xarajat bildirishnomalari (in-app +
 * realtime + Telegram DM). Qabul qiluvchi — sukut bo'yicha market EGASI;
 * (GykuOz8f) `recipientId` berilsa — o'sha foydalanuvchi (so'rov yozgan
 * kuryer / menejer). Bitta so'rovning hammasi bitta guruhda
 * (`extra_cost:<approval_id>`, har qabul qiluvchida alohida qator). Bot xabar
 * matnini o'zi yasamaydi. `manager` — chaqiruvchining tranzaksiyasi: xabar
 * qaror bilan BIRGA commit bo'ladi (yoki birga qaytadi).
 */
export async function enqueueExtraCostNotification(
  outbox: OutboxService,
  input: {
    type: ExtraCostNotificationType;
    approvalId: string;
    orderId: string;
    marketId: string;
    /** (GykuOz8f) Qabul qiluvchi; berilmasa — market egasi. */
    recipientId?: string;
    /** (GykuOz8f) Kabinetdagi nisbiy havola (`/extra-costs?tab=…`). */
    link?: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  },
  options: { manager?: EntityManager } = {},
): Promise<void> {
  const payload = {
    type: input.type,
    category: NotificationCategory.ORDER,
    priority: NotificationPriority.HIGH,
    title: input.title,
    body: input.body,
    recipient_id: input.recipientId ?? input.marketId,
    ...(input.link ? { link: input.link } : {}),
    channels: ['in_app', 'realtime', 'telegram'],
    group_key: `extra_cost:${input.approvalId}`,
    data: {
      approval_id: input.approvalId,
      order_id: input.orderId,
      ...input.data,
    },
  };
  if (options.manager) {
    await outbox.enqueue('NOTIFICATION', DISPATCH_PATTERN, payload, {
      manager: options.manager,
    });
    return;
  }
  await outbox.enqueue('NOTIFICATION', DISPATCH_PATTERN, payload);
}

/** (GykuOz8f) So'rov yozgan xodimga xabar — qaror yoki yopilish. */
export type ExtraCostDecisionKind = 'approved' | 'rejected' | 'voided';

/** Xabar uchun so'rov maydonlari (UPDATE … RETURNING qatori). */
export type ExtraCostDecisionApproval = {
  id: unknown;
  order_id: unknown;
  market_id: unknown;
  requested_by_user_id: unknown;
  action: unknown;
  amount: unknown;
  closed_reason?: unknown;
  /** (SPEC v2) 'deferred' — amal allaqachon bajarilgan, E alohida. */
  mode?: unknown;
};

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** "24 soat" (butun soat) yoki "90 daqiqa". */
export function formatExtraCostWaitPeriod(minutes: number): string {
  const safe = Math.max(Math.round(Number(minutes) || 0), 0);
  return safe > 0 && safe % 60 === 0 ? `${safe / 60} soat` : `${safe} daqiqa`;
}

/**
 * (GykuOz8f) Qaror xabari matni — kuryer / menejer uchun:
 *  - approved: «✅ EL-…: qo'shimcha xarajat tasdiqlandi» (avtomatik bo'lsa —
 *    market muddat ichida javob bermagani);
 *  - rejected: «❌ EL-…: … rad etildi — <sabab>[: <izoh>]» va buyurtma
 *    «kutilmoqda» qolgani (qayta sotish yoki bekor qilish);
 *  - voided: «⚪ EL-…: … so'rovi yopildi» — yopilish sababi bilan.
 * Havola — «Qo'shimcha xarajatli buyurtmalar» sahifasining tegishli tabi.
 */
export function buildExtraCostDecisionNotice(input: {
  kind: ExtraCostDecisionKind;
  approval: ExtraCostDecisionApproval;
  autoApproved?: boolean;
  /** Avtomatik tasdiq muddati (EXTRA_COST_AUTO_APPROVE_MINUTES). */
  autoApproveMinutes?: number;
  rejectLabel?: string | null;
  comment?: string | null;
  /** (SPEC v2) Kechiktirilgan so'rov tovarlari: «Telefon g'ilofi ×1, …». */
  products?: string | null;
}): {
  type: ExtraCostNotificationType;
  title: string;
  body: string;
  link: string;
  status: 'approved' | 'rejected' | 'void';
} {
  const orderId = text(input.approval.order_id);
  const orderNumber = formatOrderNumber(orderId) ?? `#${orderId}`;
  const amount = formatSom(input.approval.amount);
  /**
   * (SPEC v2) Kechiktirilgan so'rov: buyurtma ALLAQACHON sotilgan / bekor
   * qilingan — «kutilmoqda holatida qoldi: qayta soting» degan matn noto'g'ri
   * (kuryerni qayta sotishga undardi). Eski (replay) matnlar o'zgarmagan.
   */
  if (text(input.approval.mode) === 'deferred') {
    const products = text(input.products);
    const productsPart = products ? ` (${products})` : '';
    if (input.kind === 'approved') {
      const auto = input.autoApproved
        ? ` Market ${formatExtraCostWaitPeriod(input.autoApproveMinutes ?? 1440)} ichida javob bermadi — avtomatik tasdiqlandi.`
        : '';
      return {
        type: 'order.extra_cost_approved',
        title: `✅ ${orderNumber}: qo'shimcha xarajat tasdiqlandi`,
        body:
          `${orderNumber}: ${amount} qo'shimcha xarajat tasdiqlandi${productsPart} — ` +
          `keyingi topshirishda hisobga olinadi.${auto}`,
        link: '/extra-costs?tab=approved',
        status: 'approved',
      };
    }
    if (input.kind === 'rejected') {
      const label = text(input.rejectLabel);
      const comment = text(input.comment);
      const reason = label
        ? comment
          ? `${label}: ${comment}`
          : label
        : comment;
      const state =
        text(input.approval.action) === 'cancel'
          ? 'bekor qilingan'
          : 'sotilgan';
      return {
        type: 'order.extra_cost_rejected',
        title: `❌ ${orderNumber}: qo'shimcha xarajat rad etildi`,
        body:
          `${orderNumber}: ${amount} qo'shimcha xarajat rad etildi${reason ? ` (${reason})` : ''}${productsPart} — ` +
          `buyurtma ${state} holida qoladi, naqdni to'liq topshirasiz.`,
        link: '/extra-costs?tab=cancelled',
        status: 'rejected',
      };
    }
  }
  if (input.kind === 'approved') {
    const auto = input.autoApproved
      ? ` Market ${formatExtraCostWaitPeriod(input.autoApproveMinutes ?? 1440)} ichida javob bermadi — avtomatik tasdiqlandi.`
      : '';
    return {
      type: 'order.extra_cost_approved',
      title: `✅ ${orderNumber}: qo'shimcha xarajat tasdiqlandi`,
      body: `${amount} qo'shimcha xarajat tasdiqlandi.${auto}`,
      link: '/extra-costs?tab=approved',
      status: 'approved',
    };
  }
  if (input.kind === 'rejected') {
    const label = text(input.rejectLabel);
    const comment = text(input.comment);
    const reason = label ? (comment ? `${label}: ${comment}` : label) : comment;
    return {
      type: 'order.extra_cost_rejected',
      title: `❌ ${orderNumber}: qo'shimcha xarajat rad etildi`,
      body:
        `${amount} qo'shimcha xarajat rad etildi${reason ? ` — ${reason}` : ''}. ` +
        'Buyurtma kutilmoqda holatida qoldi: qayta soting yoki bekor qiling.',
      link: '/extra-costs?tab=cancelled',
      status: 'rejected',
    };
  }
  const closedReason = text(input.approval.closed_reason);
  return {
    type: 'order.extra_cost_voided',
    title: `⚪ ${orderNumber}: qo'shimcha xarajat so'rovi yopildi`,
    body: closedReason ? `${amount} — ${closedReason}` : amount,
    link: '/extra-costs?tab=cancelled',
    status: 'void',
  };
}

/**
 * (GykuOz8f) So'rov yozgan kuryer / menejerga (in-app + realtime + Telegram
 * DM, «🌐 Kabinetda ochish» tugmasi bilan) — tasdiqlandi, rad etildi yoki
 * yopildi. Tasdiqsiz yozilgan (`immediate`) va teskari qaytarilgan
 * (`reversed`) xarajat uchun chaqirilmaydi.
 */
export async function enqueueExtraCostDecisionNotification(
  outbox: OutboxService,
  input: Parameters<typeof buildExtraCostDecisionNotice>[0],
  options: { manager?: EntityManager } = {},
): Promise<void> {
  const notice = buildExtraCostDecisionNotice(input);
  const orderId = text(input.approval.order_id);
  await enqueueExtraCostNotification(
    outbox,
    {
      type: notice.type,
      approvalId: text(input.approval.id),
      orderId,
      marketId: text(input.approval.market_id),
      recipientId: text(input.approval.requested_by_user_id),
      link: notice.link,
      title: notice.title,
      body: notice.body,
      data: {
        order_number: formatOrderNumber(orderId),
        action: text(input.approval.action) || null,
        amount: Number(input.approval.amount ?? 0),
        status: notice.status,
        telegram_cabinet_link: true,
      },
    },
    options,
  );
}
