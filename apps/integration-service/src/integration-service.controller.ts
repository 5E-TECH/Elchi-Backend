import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

@Controller()
export class IntegrationServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly integrationService: IntegrationServiceService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
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

  @MessagePattern({ cmd: 'integration.healthcheck' })
  healthcheck(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.healthcheckIntegration(data),
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
      this.integrationService.getSyncHistory(data?.query ?? data),
    );
  }

  @MessagePattern({ cmd: 'integration.sync.enqueue' })
  enqueueSync(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.enqueueSync(data),
    );
  }

  @MessagePattern({ cmd: 'integration.sync.queue' })
  queueSync(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.enqueueSync(data),
    );
  }

  @MessagePattern({ cmd: 'integration.sync.process' })
  processSync(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.processPendingSyncQueue(
        Number(data?.limit ?? 20),
        data?.integration_id ? String(data.integration_id) : undefined,
      ),
    );
  }

  @MessagePattern({ cmd: 'integration.sync.retry' })
  retrySync(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.retrySyncQueue(
        data?.queue_id ? String(data.queue_id) : undefined,
        data?.integration_id ? String(data.integration_id) : undefined,
      ),
    );
  }

  @MessagePattern({ cmd: 'integration.sync.queue_status' })
  queueStatus(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.getQueueStatus(),
    );
  }

  // --- Inbound webhooks ---
  @MessagePattern({ cmd: 'integration.webhook.receive' })
  receiveWebhook(
    @Payload()
    data: {
      slug: string;
      raw_body_base64?: string;
      raw_body?: string;
      headers?: Record<string, string>;
      trace_id?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.receiveWebhook(data),
    );
  }

  // --- Provider shipments ---
  @MessagePattern({ cmd: 'integration.shipment.upsert' })
  upsertShipment(
    @Payload()
    data: {
      order_id: string;
      integration_id: string;
      provider_slug?: string | null;
      external_ref?: string | null;
      tracking_number?: string | null;
      provider_status?: string | null;
      internal_status?: string | null;
      last_request_id?: string | null;
      meta?: Record<string, unknown> | null;
      increment_attempt?: boolean;
      last_error?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.upsertShipment(data),
    );
  }

  @MessagePattern({ cmd: 'integration.shipment.get' })
  getShipment(
    @Payload() data: { order_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.getShipmentByOrder(data.order_id),
    );
  }

  @MessagePattern({ cmd: 'integration.shipment.list' })
  listShipments(
    @Payload()
    data: {
      integration_id?: string;
      internal_status?: string;
      limit?: number;
      offset?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.listShipments(data),
    );
  }

  @MessagePattern({ cmd: 'integration.shipment.dispatch' })
  dispatchShipment(
    @Payload()
    data: {
      slug?: string;
      integration_id?: string;
      order_id: string;
      context?: Record<string, string>;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.dispatchShipment(data),
    );
  }
}
