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

  // --- Partner API (Elchi Partner API) auth + boshqaruv ---
  @MessagePattern({ cmd: 'integration.partner.validate_key' })
  validatePartnerKey(
    @Payload() data: { api_key?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.validatePartnerKey(data?.api_key ?? ''),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.create' })
  createPartner(
    @Payload()
    data: {
      name?: string;
      webhook_url?: string | null;
      webhook_secret?: string | null;
      ip_allowlist?: string[] | null;
      requester?: { id?: string; roles?: string[] } | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.createPartner(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.rotate_key' })
  rotatePartnerKey(
    @Payload()
    data: { id?: string; requester?: { id?: string; roles?: string[] } | null },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.rotatePartnerKey(
        String(data?.id),
        data?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.set_active' })
  setPartnerActive(
    @Payload()
    data: {
      id?: string;
      is_active?: boolean;
      requester?: { id?: string; roles?: string[] } | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.setPartnerActive(
        String(data?.id),
        Boolean(data?.is_active),
        data?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.list' })
  listPartners(@Payload() _data: unknown, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.listPartners(),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.provision_market' })
  provisionPartnerMarket(
    @Payload()
    data: {
      partner_id?: string;
      external_seller_id?: string;
      name?: string;
      phone?: string;
      tariff_home?: number;
      tariff_center?: number;
      requester?: { id?: string; roles?: string[] } | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.provisionPartnerMarket(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.create_shipment' })
  createPartnerShipment(
    @Payload()
    data: {
      partner_id?: string;
      external_order_id?: string;
      elchi_market_id?: string;
      customer?: { name?: string; phone?: string };
      address?: string | null;
      region_id?: string | null;
      district_id?: string | null;
      where_deliver?: string;
      items?: Array<{ name?: string; quantity?: number }>;
      cod_amount?: number;
      subtotal?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.createPartnerShipment(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.get_shipment' })
  getPartnerShipment(
    @Payload() data: { partner_id?: string; shipment_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.getPartnerShipment(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'integration.partner.cancel_shipment' })
  cancelPartnerShipment(
    @Payload() data: { partner_id?: string; shipment_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.cancelPartnerShipment(data ?? {}),
    );
  }

  // C2.3 — order-service status o'zgarganда chaqiradi (external_id bo'lgan order
  // uchun). Partner order emas bo'lsa integration-service ичida no-op.
  @MessagePattern({ cmd: 'integration.partner.webhook.enqueue' })
  enqueuePartnerWebhook(
    @Payload()
    data: {
      order_id?: string;
      external_order_id?: string;
      action?: string;
      old_status?: string;
      new_status?: string;
      cod_collected?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.enqueuePartnerWebhook(data ?? {}),
    );
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
      this.integrationService.deleteIntegration(String(data?.id), data?.requester),
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

  // ===== Provider COD reconciliation =====

  @MessagePattern({ cmd: 'integration.receivable.list' })
  listReceivables(
    @Payload()
    data: {
      integration_id?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.listReceivables(data),
    );
  }

  @MessagePattern({ cmd: 'integration.receivable.balance' })
  getProviderBalance(
    @Payload() data: { integration_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.getProviderBalance(data.integration_id),
    );
  }

  @MessagePattern({ cmd: 'integration.remittance.create' })
  createRemittance(
    @Payload()
    data: {
      integration_id: string;
      amount: number;
      reference?: string | null;
      note?: string | null;
      order_ids?: string[];
      created_by?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.integrationService.createRemittance(data),
    );
  }

  // --- Activity log (audit) read fan-in ---
  @MessagePattern({ cmd: 'integration.activity_log.find_all' })
  activityLogFindAll(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'integration.activity_log.find_by_entity' })
  activityLogFindByEntity(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.integrationService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
