import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { AnalyticsServiceService } from './analytics-service.service';

interface AnalyticsRequester {
  id: string;
  roles?: string[];
  branch_id?: string;
}

interface AnalyticsFilter {
  startDate?: string;
  endDate?: string;
  fromDate?: string;
  toDate?: string;
  period?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

interface AnalyticsPayload {
  requester?: AnalyticsRequester;
  filter?: AnalyticsFilter;
}

@Controller()
export class AnalyticsServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly analyticsService: AnalyticsServiceService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  @MessagePattern({ cmd: 'analytics.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'analytics-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'analytics.dashboard' })
  getDashboard(
    @Payload() data: AnalyticsPayload | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.analyticsService.getDashboard(data?.requester, data?.filter ?? {}),
    );
  }

  @MessagePattern({ cmd: 'analytics.revenue' })
  getRevenue(
    @Payload() data: AnalyticsPayload | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.analyticsService.getRevenueStats(
        data?.requester,
        data?.filter ?? {},
      ),
    );
  }

  @MessagePattern({ cmd: 'analytics.kpi' })
  getKpi(
    @Payload() data: AnalyticsPayload | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.analyticsService.getKpiStats(data?.requester, data?.filter ?? {}),
    );
  }

  @MessagePattern({ cmd: 'analytics.report.orders' })
  orderReport(
    @Payload() data: AnalyticsPayload | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.analyticsService.getOrderReport(data?.requester, data?.filter ?? {}),
    );
  }

  @MessagePattern({ cmd: 'analytics.report.finance' })
  financeReport(
    @Payload() data: AnalyticsPayload | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.analyticsService.getFinanceReport(
        data?.requester,
        data?.filter ?? {},
      ),
    );
  }

  @MessagePattern({ cmd: 'analytics.report.couriers' })
  courierReport(
    @Payload() data: AnalyticsPayload | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.analyticsService.getCourierReport(
        data?.requester,
        data?.filter ?? {},
      ),
    );
  }
}
