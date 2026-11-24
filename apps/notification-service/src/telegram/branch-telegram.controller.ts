import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  BranchTelegramService,
  type BranchTelegramRequester,
} from './branch-telegram.service';

/** RMQ buyruqlari — filial kassasi Telegram guruhi. */
export const BRANCH_TELEGRAM_PATTERNS = {
  linkCode: 'notification.telegram.branch_link_code',
  status: 'notification.telegram.branch_status',
  reportTarget: 'notification.telegram.branch_report_target',
  unlink: 'notification.telegram.branch_unlink',
  route: 'notification.telegram.branch_route',
  routes: 'notification.telegram.branch_routes',
} as const;

/**
 * Filial kassasi Telegram guruhi. Panel buyruqlari (`link_code`, `status`,
 * `report_target`, `unlink`) — faqat gateway'dan, filialga kirish huquqi
 * u yerda tekshirilgan; `route` / `routes` — finance-service smena hisoboti
 * (faqat o'qish).
 */
@Controller()
export class BranchTelegramController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly branches: BranchTelegramService,
  ) {}

  @MessagePattern({ cmd: BRANCH_TELEGRAM_PATTERNS.linkCode })
  linkCode(
    @Payload()
    data: {
      branch_id?: string;
      branch_name?: string;
      requester?: BranchTelegramRequester;
      ip?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.branches.issueLinkCode(data ?? {}),
    );
  }

  @MessagePattern({ cmd: BRANCH_TELEGRAM_PATTERNS.status })
  status(@Payload() data: { branch_id?: string }, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.branches.status(data ?? {}),
    );
  }

  @MessagePattern({ cmd: BRANCH_TELEGRAM_PATTERNS.reportTarget })
  reportTarget(
    @Payload()
    data: {
      branch_id?: string;
      report_target?: string;
      requester?: BranchTelegramRequester;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.branches.setReportTarget(data ?? {}),
    );
  }

  @MessagePattern({ cmd: BRANCH_TELEGRAM_PATTERNS.unlink })
  unlink(
    @Payload()
    data: { branch_id?: string; requester?: BranchTelegramRequester },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.branches.unlink(data ?? {}),
    );
  }

  @MessagePattern({ cmd: BRANCH_TELEGRAM_PATTERNS.route })
  route(@Payload() data: { branch_id?: string }, @Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.branches.route(data ?? {}),
    );
  }

  @MessagePattern({ cmd: BRANCH_TELEGRAM_PATTERNS.routes })
  routes(@Ctx() context: RmqContext) {
    return executeAndAck(this.rmqService, context, () =>
      this.branches.routes(),
    );
  }
}
