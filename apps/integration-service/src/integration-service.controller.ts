import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

@Controller()
export class IntegrationServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly integrationService: IntegrationServiceService,
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

  @MessagePattern({ cmd: 'integration.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'integration-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  // --- ExternalIntegration ---
  @MessagePattern({ cmd: 'integration.create' })
  create(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.createIntegration(data?.dto ?? data),
    );
  }

  @MessagePattern({ cmd: 'integration.find_all' })
  findAll(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.findAllIntegrations(data?.query ?? data),
    );
  }

  @MessagePattern({ cmd: 'integration.find_by_id' })
  findById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.findIntegrationById(String(data?.id)),
    );
  }

  @MessagePattern({ cmd: 'integration.update' })
  update(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.updateIntegration(String(data?.id), data?.dto ?? {}),
    );
  }

  @MessagePattern({ cmd: 'integration.delete' })
  remove(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.deleteIntegration(String(data?.id)),
    );
  }

  @MessagePattern({ cmd: 'integration.external.request' })
  externalRequest(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.externalRequest(data),
    );
  }

  @MessagePattern({ cmd: 'integration.external.search_by_qr' })
  searchByQr(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.searchByQr(data),
    );
  }

  // --- Sync ---
  @MessagePattern({ cmd: 'integration.sync.trigger' })
  triggerSync(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      message: 'sync trigger hook is reserved',
    }));
  }

  @MessagePattern({ cmd: 'integration.sync.history' })
  syncHistory(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.getSyncHistory(
        Number(data?.limit ?? 50),
        data?.integration_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'integration.sync.enqueue' })
  enqueueSync(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.enqueueSync(data),
    );
  }

  @MessagePattern({ cmd: 'integration.sync.queue_status' })
  queueStatus(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.getQueueStatus(),
    );
  }
}
