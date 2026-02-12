import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { AnalyticsServiceService } from './analytics-service.service';

@Controller()
export class AnalyticsServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly analyticsService: AnalyticsServiceService,
  ) {}

  private async executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await handler();
    } finally {
      this.rmqService.ack(context);
    }
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
  getDashboard(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'analytics.kpi' })
  getKpi(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'analytics.report.orders' })
  orderReport(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'analytics.report.finance' })
  financeReport(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'analytics.report.couriers' })
  courierReport(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }
}
