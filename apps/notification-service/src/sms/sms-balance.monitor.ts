import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  startOfTashkentDay,
} from '@app/common';
import { NotificationInboxService } from '../notification-inbox.service';
import { SmsConfigService } from './sms-config.service';
import { SmsOutboxScheduler } from './sms-outbox.scheduler';
import { SmsProviderRegistry } from './sms-provider.registry';

/**
 * Provayder balansi chegaradan tushsa admin inboxiga CRITICAL (8auPBa1O #7) —
 * mavjud dispatch orqali, Toshkent kuniga BIR marta.
 */
@Injectable()
export class SmsBalanceMonitor implements OnModuleInit {
  private readonly logger = new Logger(SmsBalanceMonitor.name);
  private lastAlertDay: number | null = null;

  constructor(
    private readonly sms: SmsConfigService,
    private readonly config: ConfigService,
    private readonly registry: SmsProviderRegistry,
    private readonly scheduler: SmsOutboxScheduler,
    private readonly inbox: NotificationInboxService,
  ) {}

  onModuleInit() {
    this.scheduler.balanceCheck = () => this.check();
  }

  async check(
    now = new Date(),
  ): Promise<'skipped' | 'ok' | 'alerted' | 'already_alerted'> {
    const threshold = this.sms.balanceAlertThreshold;
    if (threshold === null || !this.sms.enabled) return 'skipped';
    const adapter = await this.registry.resolve('default');
    if (!adapter) return 'skipped';
    const balance = await adapter.getBalance();
    if (balance === null || balance >= threshold) return 'ok';

    const day = startOfTashkentDay(now).getTime();
    if (this.lastAlertDay === day) return 'already_alerted';
    const recipientIds = String(
      this.config.get('SMS_ALERT_RECIPIENT_IDS') ?? '',
    )
      .split(',')
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id));
    await this.inbox.dispatch({
      type: 'sms.balance_low',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.CRITICAL,
      title: 'SMS balansi tugayapti',
      body: `${adapter.provider} balansi: ${balance.toLocaleString('uz-UZ')} so'm (chegara ${threshold.toLocaleString('uz-UZ')}). To'ldirilmasa SMS va OTP to'xtaydi.`,
      roles: ['admin'],
      ...(recipientIds.length ? { recipient_ids: recipientIds } : {}),
      channels: [NotificationChannel.IN_APP, NotificationChannel.REALTIME],
      group_key: `sms-balance-low-${day}`,
    } as never);
    this.lastAlertDay = day;
    this.logger.warn(
      `SMS balansi past: ${balance} < ${threshold} — adminlarga CRITICAL yuborildi`,
    );
    return 'alerted';
  }
}
