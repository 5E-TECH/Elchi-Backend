import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  NotificationCategory,
  NotificationPriority,
  rmqSend,
} from '@app/common';
import {
  AiKeyStoreService,
  type AiKeyChangeEvent,
} from './ai-key-store.service';

/**
 * «AI kalit va modellar» inbox xabari (be-brief §10): superadmin + admin'ga
 * `notification.dispatch` orqali (AiBudgetNotifier yo'li). COMMIT'dan KEYIN,
 * asinxron — yozuvni hech qachon to'smaydi; xato yutiladi (WARN).
 *
 * Ops Telegram xabari — alohida (host cron, audit qatorlaridan).
 * ⚠️ Matnda kalit qiymati yo'q — faqat `hint` (sk-ant-…XXXX).
 */
export const AI_CONFIG_NOTIFY_ROLES = ['superadmin', 'admin'];
export const AI_CONFIG_NOTIFY_TIMEOUT_MS = 1500;

const TITLES: Record<string, string> = {
  'ai.key.add': "AI kaliti qo'shildi",
  'ai.key.replace': 'AI kaliti almashtirildi',
  'ai.key.restore': 'Oldingi AI kalitiga qaytarildi',
  'ai.key.deactivate': "AI kaliti o'chirildi",
  'ai.key.forget': "Oldingi AI kaliti o'chirib tashlandi",
  'ai.key.runtime_failure': "AI kaliti ishlamay qoldi — AI to'xtagan",
  'ai.key.unreadable': "Saqlangan AI kalitini ochib bo'lmadi — AI to'xtagan",
  'ai.key.reencrypt': 'AI kaliti qayta shifrlandi',
  'ai.models.update': "AI modeli o'zgartirildi",
  'ai.models.auto_revert': 'AI modeli avtomatik qaytarildi',
  'ai.models.unavailable': 'AI modeli mavjud emas',
};
const CRITICAL = new Set(['ai.key.runtime_failure', 'ai.key.unreadable']);

export interface AiConfigNotice {
  action: string;
  auditId: string;
  hint?: string | null;
  actorName?: string | null;
  detail?: string | null;
}

@Injectable()
export class AiConfigNotifier implements OnModuleInit {
  private readonly logger = new Logger(AiConfigNotifier.name);

  constructor(
    @Inject('NOTIFICATION') private readonly client: ClientProxy,
    @Optional() private readonly store?: AiKeyStoreService,
  ) {}

  onModuleInit(): void {
    this.store?.onChange((e: AiKeyChangeEvent) => {
      void this.notify(e);
    });
  }

  /** Throw qilmaydi. `ai.key.verify` / `attempt_rejected` — inbox'ga emas. */
  async notify(n: AiConfigNotice): Promise<void> {
    const title = TITLES[n.action];
    if (!title) return;
    const isModel = n.action.startsWith('ai.models.');
    const type = isModel ? 'ai.model_alert' : 'ai.key_alert';
    const parts = [
      n.actorName ? `Kim: ${n.actorName.slice(0, 120)}` : null,
      n.hint ? `Kalit: ${n.hint}` : null,
      n.detail ? n.detail.slice(0, 200) : null,
      'Batafsil: Ops → «AI kalit va modellar» → Tarix',
    ].filter(Boolean);
    try {
      await rmqSend(
        this.client,
        { cmd: 'notification.dispatch' },
        {
          roles: AI_CONFIG_NOTIFY_ROLES,
          type,
          category: NotificationCategory.SYSTEM,
          priority: CRITICAL.has(n.action)
            ? NotificationPriority.CRITICAL
            : NotificationPriority.HIGH,
          title,
          body: parts.join('\n'),
          data: { action: n.action, audit_id: n.auditId, hint: n.hint ?? null },
          group_key: `${type}:${n.auditId}`,
        },
        { timeoutMs: AI_CONFIG_NOTIFY_TIMEOUT_MS, retries: 0 },
      );
    } catch (err) {
      this.logger.warn(
        `ai_config_notify_failed action=${n.action}: ${
          err instanceof Error ? err.name : 'non-error throw'
        }`,
      );
    }
  }
}
