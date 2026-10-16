import {
  NotificationCategory,
  NotificationPriority,
  OutboxService,
} from '@app/common';

/** Bildirishnoma yadrosiga (notification-service) outbox hodisasi. */
const DISPATCH_PATTERN = 'notification.dispatch';

export type ExtraCostNotificationType =
  | 'order.extra_cost_requested'
  | 'order.extra_cost_reminder'
  | 'order.extra_cost_auto_approved';

/** "250 000 so'm" — `numeric` satr ham to'g'ri. */
export function formatSom(value: unknown): string {
  const amount = Number(
    typeof value === 'string' || typeof value === 'number' ? value : 0,
  );
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return `${String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`;
}

/**
 * (DuST9k8j / 1tnpaIqd) Qo'shimcha xarajat bildirishnomalari — market
 * EGASIGA (in-app + realtime + Telegram DM). Bitta so'rovning hammasi bitta
 * guruhda (`extra_cost:<approval_id>`). Bot xabar matnini o'zi yasamaydi.
 */
export async function enqueueExtraCostNotification(
  outbox: OutboxService,
  input: {
    type: ExtraCostNotificationType;
    approvalId: string;
    orderId: string;
    marketId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await outbox.enqueue('NOTIFICATION', DISPATCH_PATTERN, {
    type: input.type,
    category: NotificationCategory.ORDER,
    priority: NotificationPriority.HIGH,
    title: input.title,
    body: input.body,
    recipient_id: input.marketId,
    channels: ['in_app', 'realtime', 'telegram'],
    group_key: `extra_cost:${input.approvalId}`,
    data: {
      approval_id: input.approvalId,
      order_id: input.orderId,
      ...input.data,
    },
  });
}
