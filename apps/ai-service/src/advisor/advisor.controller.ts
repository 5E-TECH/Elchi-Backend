import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  AI_ADVISOR_PATTERNS,
  RmqService,
  executeAndAck,
  type AiAdvisorAlertGetRequest,
  type AiAdvisorAlertUpdateRequest,
  type AiAdvisorAlertsQuery,
  type AiAdvisorRequester,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { advisorCall, assertSuperadmin } from './advisor-errors';
import { AdvisorAlertsService } from './advisor-alerts.service';
import { AdvisorExplainService } from './advisor-explain.service';
import { AdvisorSettingsService } from './advisor-settings.service';

/**
 * BE-5 (LhTIno57) — AI maslahatchi RMQ handler'lari (`ai.advisor.*`).
 * Har handler `requester` rolini QAYTA tekshiradi (faqat superadmin).
 * Javob — `successRes` konverti (gateway o'zgarishsiz qaytaradi).
 */
@Controller()
export class AdvisorController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly settings: AdvisorSettingsService,
    private readonly alerts: AdvisorAlertsService,
    private readonly explain: AdvisorExplainService,
  ) {}

  @MessagePattern({ cmd: AI_ADVISOR_PATTERNS.OVERVIEW })
  overview(
    @Payload() data: { requester?: AiAdvisorRequester },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      advisorCall(AI_ADVISOR_PATTERNS.OVERVIEW, async () => {
        assertSuperadmin(data?.requester);
        return successRes(
          await this.alerts.overview(),
          200,
          'AI advisor overview',
        );
      }),
    );
  }

  @MessagePattern({ cmd: AI_ADVISOR_PATTERNS.ALERTS_LIST })
  listAlerts(
    @Payload()
    data: { requester?: AiAdvisorRequester; query?: AiAdvisorAlertsQuery },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      advisorCall(AI_ADVISOR_PATTERNS.ALERTS_LIST, async () => {
        assertSuperadmin(data?.requester);
        return successRes(
          await this.alerts.list(data?.query ?? {}),
          200,
          'AI advisor alerts',
        );
      }),
    );
  }

  @MessagePattern({ cmd: AI_ADVISOR_PATTERNS.ALERTS_GET })
  getAlert(
    @Payload() data: Partial<AiAdvisorAlertGetRequest>,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      advisorCall(AI_ADVISOR_PATTERNS.ALERTS_GET, async () => {
        const requester = assertSuperadmin(data?.requester);
        return successRes(
          await this.alerts.get(requester, String(data?.id ?? ''), {
            mark_seen: data?.mark_seen !== false,
            include: Array.isArray(data?.include) ? data.include : [],
          }),
          200,
          'AI advisor alert',
        );
      }),
    );
  }

  @MessagePattern({ cmd: AI_ADVISOR_PATTERNS.ALERTS_UPDATE })
  updateAlert(
    @Payload() data: Partial<AiAdvisorAlertUpdateRequest>,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      advisorCall(AI_ADVISOR_PATTERNS.ALERTS_UPDATE, async () => {
        const requester = assertSuperadmin(data?.requester);
        return successRes(
          await this.alerts.update(
            requester,
            String(data?.id ?? ''),
            data?.status,
            data?.note,
          ),
          200,
          'AI advisor alert updated',
        );
      }),
    );
  }

  /** §7.4 — doim 202 (`pending`/`ready`); 429 budjet, 503 AI o'chiq. */
  @MessagePattern({ cmd: AI_ADVISOR_PATTERNS.ALERTS_EXPLAIN })
  explainAlert(
    @Payload() data: { requester?: AiAdvisorRequester; id?: string },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      advisorCall(AI_ADVISOR_PATTERNS.ALERTS_EXPLAIN, async () => {
        const requester = assertSuperadmin(data?.requester);
        return successRes(
          await this.explain.request(requester, String(data?.id ?? '')),
          202,
          'AI advisor explanation',
        );
      }),
    );
  }

  @MessagePattern({ cmd: AI_ADVISOR_PATTERNS.SETTINGS_GET })
  getSettings(
    @Payload() data: { requester?: AiAdvisorRequester },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      advisorCall(AI_ADVISOR_PATTERNS.SETTINGS_GET, async () => {
        assertSuperadmin(data?.requester);
        return successRes(
          await this.settings.get(),
          200,
          'AI advisor settings',
        );
      }),
    );
  }

  @MessagePattern({ cmd: AI_ADVISOR_PATTERNS.SETTINGS_UPDATE })
  updateSettings(
    @Payload()
    data: { requester?: AiAdvisorRequester; patch?: Record<string, unknown> },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      advisorCall(AI_ADVISOR_PATTERNS.SETTINGS_UPDATE, async () => {
        const requester = assertSuperadmin(data?.requester);
        return successRes(
          await this.settings.update(requester, data?.patch),
          200,
          'AI advisor settings',
        );
      }),
    );
  }
}
