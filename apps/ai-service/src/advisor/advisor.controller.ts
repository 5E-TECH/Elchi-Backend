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
  type AiAdvisorRequester,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { advisorCall, assertSuperadmin } from './advisor-errors';
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
  ) {}

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
