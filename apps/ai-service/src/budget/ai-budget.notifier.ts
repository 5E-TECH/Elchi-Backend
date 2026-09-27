import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  NotificationCategory,
  NotificationPriority,
  rmqSend,
} from '@app/common';

/** Kunlik shift bildirishnomasi turlari (`notification.dispatch.type`). */
export type AiCapNotificationType = 'ai.cap_warning' | 'ai.cap_exceeded';

export interface AiCapNotification {
  type: AiCapNotificationType;
  priority: NotificationPriority;
  title: string;
  body: string;
  periodKey: string;
  spentUsd: number;
  capUsd: number;
}

/** Bildirishnoma kutish shifti — AI javobini uzoq ushlab turmasin. */
export const AI_CAP_NOTIFY_TIMEOUT_MS = 1500;

/** Bildirishnoma oladigan rollar (Roles.SUPERADMIN / Roles.ADMIN). */
export const AI_CAP_NOTIFY_ROLES = ['superadmin', 'admin'];

/**
 * Global kunlik shift bildirishnomalari (wFSMEIIy #7/#17) —
 * notification-service `notification.dispatch` orqali superadmin va
 * admin'larga (in-app + realtime).
 *
 * ⚠️ `retries: 0` — bildirishnoma ikki marta ketmasin; "kuniga bir marta"
 * kafolatini `warned_at`/`exceeded_at` beradi, qayta yuborish emas.
 * ⚠️ Xato YUTILADI (faqat WARN) — bildirishnoma yiqilsa ham AI oqimi va
 * shift qarori buzilmaydi.
 */
@Injectable()
export class AiBudgetNotifier {
  private readonly logger = new Logger(AiBudgetNotifier.name);

  constructor(
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
  ) {}

  async notify(n: AiCapNotification): Promise<void> {
    try {
      await rmqSend(
        this.notificationClient,
        { cmd: 'notification.dispatch' },
        {
          roles: AI_CAP_NOTIFY_ROLES,
          type: n.type,
          category: NotificationCategory.SYSTEM,
          priority: n.priority,
          title: n.title,
          body: n.body,
          data: {
            period_key: n.periodKey,
            spent_usd: n.spentUsd,
            cap_usd: n.capUsd,
          },
          group_key: `${n.type}:${n.periodKey}`,
        },
        { timeoutMs: AI_CAP_NOTIFY_TIMEOUT_MS, retries: 0 },
      );
    } catch (err) {
      this.logger.warn(
        `ai_cap_notify_failed type=${n.type} period=${n.periodKey}: ${
          err instanceof Error ? err.message : 'non-error throw'
        }`,
      );
    }
  }
}
