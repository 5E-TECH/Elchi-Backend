import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

/**
 * BE-5 (LhTIno57) — yengil realtime hodisa `ai.advisor.alert_changed`
 * (§12): superadminlarga, PUL SUMMASISIZ — FE `overview`, ro'yxat va ochiq
 * tafsilotni REST'dan qayta o'qiydi. Gateway `@EventPattern('realtime.notify')`
 * — javob kutilmaydi (`emit`); yetkazilmasa faqat sahifa o'zi yangilanmaydi
 * (FE 60 s poll va fokusda qayta o'qiydi). Xato yutiladi.
 */
export const ADVISOR_REALTIME_EVENT = 'ai.advisor.alert_changed';

export type AdvisorAlertChange =
  'opened' | 'occurred' | 'status' | 'explanation';

export interface AdvisorAlertChangedPayload {
  alert_id: string;
  rule_key: string;
  severity: string;
  status: string;
  change: AdvisorAlertChange;
  explanation_status: string;
  at: string;
}

@Injectable()
export class AdvisorRealtime {
  private readonly logger = new Logger(AdvisorRealtime.name);

  constructor(
    @Optional() @Inject('GATEWAY') private readonly gateway?: ClientProxy,
  ) {}

  emit(changes: AdvisorAlertChangedPayload[]): void {
    if (!this.gateway) return;
    for (const payload of changes) {
      try {
        this.gateway
          .emit(
            { cmd: 'realtime.notify' },
            {
              event: ADVISOR_REALTIME_EVENT,
              targets: [{ role: 'superadmin' }],
              payload,
            },
          )
          .subscribe({
            error: (err: unknown) =>
              this.logger.warn(
                `ai_advisor_realtime_failed: ${err instanceof Error ? err.message : 'unknown'}`,
              ),
          });
      } catch (err) {
        this.logger.warn(
          `ai_advisor_realtime_failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
  }
}
