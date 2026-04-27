import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import { OrderServiceService } from './order-service.service';
import { Order_source } from './entities/order.entity';

@Controller()
export class OrderServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly orderService: OrderServiceService,
  ) {}

  private async executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    try {
      const result = await handler();
      this.rmqService.ack(context);
      return result;
    } catch (error) {
      this.rmqService.nack(context);
      throw error;
    }
  }

  @MessagePattern({ cmd: 'salom_ber_order' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      message: 'Salom! Men Order Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'order.create' })
  create(
    @Payload()
    data: {
      dto: {
        market_id: string;
        customer_id: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        paid_amount?: number;
        status?: Order_status;
        comment?: string | null;
        operator?: string | null;
        operator_id?: string | null;
        post_id?: string | null;
        branch_id?: string | null;
        current_batch_id?: string | null;
        courier_id?: string | null;
        assigned_at?: string | Date | null;
        return_reason?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        parent_order_id?: string | null;
        external_id?: string | null;
        source?: Order_source;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
      requester?: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.create(data.dto, data.requester));
  }

  @MessagePattern({ cmd: 'order.find_all' })
  findAll(
    @Payload()
    data: {
      query: {
        market_id?: string;
        customer_id?: string;
        post_id?: string;
        post_ids?: string[];
        exclude_statuses?: Order_status[];
        canceled_post_id?: string;
        qr_code_token?: string;
        status?: Order_status | Order_status[] | string | string[];
        return_requested?: boolean;
        start_day?: string;
        end_day?: string;
        courier?: string;
        region_id?: string;
        branch_id?: string;
        source?: Order_source | 'internal' | 'external' | 'branch';
        fetch_all?: boolean | string;
        fetchAll?: boolean | string;
        page?: number;
        limit?: number;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.findAll(data.query));
  }

  @MessagePattern({ cmd: 'order.find_by_id' })
  findById(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.findById(data.id));
  }

  @MessagePattern({ cmd: 'order.find_by_qr' })
  findByQr(
    @Payload() data: { token: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.findByQrCode(data.token));
  }

  @MessagePattern({ cmd: 'order.find_by_qr_enriched' })
  findByQrEnriched(
    @Payload() data: { token: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.findByQrCodeEnriched(data.token));
  }

  @MessagePattern({ cmd: 'order.tracking' })
  tracking(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.getTrackingByOrderId(data.id));
  }

  @MessagePattern({ cmd: 'order.find_new_markets' })
  findNewMarkets(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.orderService.findNewMarkets());
  }

  @MessagePattern({ cmd: 'order.find_new_by_market' })
  findNewByMarket(
    @Payload()
    data: { market_id: string; page?: number; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewOrdersByMarket(
        data.market_id,
        data.page,
        data.limit,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.receive' })
  receive(
    @Payload() data: { order_ids: string[]; search?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.receiveNewOrders(data.order_ids, data.search),
    );
  }

  @MessagePattern({ cmd: 'order.sell' })
  sell(
    @Payload()
    data: {
      id: string;
      dto: { comment?: string; extraCost?: number; paidAmount?: number };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.sellOrder(data.requester, data.id, data.dto ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.cancel' })
  cancel(
    @Payload()
    data: {
      id: string;
      dto: { comment?: string; extraCost?: number };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.cancelOrder(data.requester, data.id, data.dto ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.partly_sell' })
  partlySell(
    @Payload()
    data: {
      id: string;
      dto: {
        order_item_info: Array<{ product_id: string; quantity: number }>;
        totalPrice: number;
        extraCost?: number;
        comment?: string;
      };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.partlySellOrder(data.requester, data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'order.rollback_waiting' })
  rollbackToWaiting(
    @Payload()
    data: {
      id: string;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.rollbackOrderToWaiting(data.requester, data.id),
    );
  }

  @MessagePattern({ cmd: 'order.update' })
  update(
    @Payload()
    data: {
      id: string;
      dto: {
        market_id?: string;
        customer_id?: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        paid_amount?: number;
        status?: Order_status;
        return_requested?: boolean;
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        canceled_post_id?: string | null;
        branch_id?: string | null;
        current_batch_id?: string | null;
        courier_id?: string | null;
        assigned_at?: string | Date | null;
        return_reason?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        external_id?: string | null;
        source?: Order_source;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
      requester?: { id?: string; roles?: string[]; note?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    // Backward compatibility: old pattern now supports full update payload too.
    return this.executeAndAck(context, () =>
      this.orderService.updateFull(data.id, data.dto, data.requester),
    );
  }

  @MessagePattern({ cmd: 'order.update_full' })
  updateFull(
    @Payload()
    data: {
      id: string;
      dto: {
        market_id?: string;
        customer_id?: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        paid_amount?: number;
        status?: Order_status;
        return_requested?: boolean;
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        canceled_post_id?: string | null;
        branch_id?: string | null;
        current_batch_id?: string | null;
        courier_id?: string | null;
        assigned_at?: string | Date | null;
        return_reason?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        external_id?: string | null;
        source?: Order_source;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
      requester?: { id?: string; roles?: string[]; note?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.updateFull(data.id, data.dto, data.requester),
    );
  }

  @MessagePattern({ cmd: 'order.receive_external' })
  receiveExternalOrders(
    @Payload() data: { integration_id: string; orders: any[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.receiveExternalOrders(data),
    );
  }

  @MessagePattern({ cmd: 'order.external.find_all' })
  findAllExternal(
    @Payload()
    data: {
      query: {
        market_id?: string;
        status?: Order_status | Order_status[] | string | string[];
        start_day?: string;
        end_day?: string;
        page?: number;
        limit?: number;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findAllExternal(data.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.external.create' })
  createExternal(
    @Payload()
    data: {
      dto: {
        market_id: string;
        customer_id: string;
        where_deliver?: Where_deliver;
        total_price?: number;
        to_be_paid?: number;
        paid_amount?: number;
        status?: Order_status;
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        external_id?: string | null;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.createExternalOrder(data.dto),
    );
  }

  @MessagePattern({ cmd: 'order.delete' })
  remove(
    @Payload() data: { id: string; requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.remove(data.id, data.requester),
    );
  }

  // ==================== Enriched Endpoints ====================

  @MessagePattern({ cmd: 'order.find_all_enriched' })
  findAllEnriched(
    @Payload() data: { query: Record<string, unknown> },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findAllEnriched(data.query as any),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_id_enriched' })
  findByIdEnriched(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findByIdEnriched(data.id),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_markets_enriched' })
  findNewMarketsEnriched(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewMarketsEnriched(),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_by_market_enriched' })
  findNewByMarketEnriched(
    @Payload() data: { market_id: string; page?: number; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewByMarketEnriched(data.market_id, data.page, data.limit),
    );
  }

  @MessagePattern({ cmd: 'order.update_normalized' })
  updateNormalized(
    @Payload()
    data: {
      id: string;
      dto: Record<string, any>;
      requester?: { id?: string; roles?: string[]; note?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => {
      const normalized = this.orderService.normalizeUpdatePayload(data.dto);
      return this.orderService.updateFull(data.id, normalized as any, data.requester);
    });
  }

  @MessagePattern({ cmd: 'order.analytics.overview' })
  analyticsOverview(
    @Payload() data: { startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getOverviewStats(data.startDate, data.endDate),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.market_stats' })
  analyticsMarketStats(
    @Payload() data: { startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getMarketStats(data.startDate, data.endDate),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.courier_stats' })
  analyticsCourierStats(
    @Payload() data: { startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getCourierStats(data.startDate, data.endDate),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_markets' })
  analyticsTopMarkets(
    @Payload() data: { limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getTopMarkets(data.limit),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_couriers' })
  analyticsTopCouriers(
    @Payload() data: { limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getTopCouriers(data.limit),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_operators_by_market' })
  analyticsTopOperatorsByMarket(
    @Payload() data: { requester: { id: string }; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getTopOperatorsByMarket(data.requester.id, data.limit),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.courier_stat' })
  analyticsCourierStat(
    @Payload() data: { requester: { id: string }; startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getCourierStat(data.requester.id, data.startDate, data.endDate),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.market_stat' })
  analyticsMarketStat(
    @Payload() data: { requester: { id: string }; startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getMarketStat(data.requester.id, data.startDate, data.endDate),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.revenue' })
  analyticsRevenue(
    @Payload() data: { startDate?: string; endDate?: string; period?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getRevenueStats(data.startDate, data.endDate, data.period),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.create' })
  createTransferBatch(
    @Payload()
    data: {
      source_branch_id: string;
      destination_branch_id: string;
      direction?: 'FORWARD' | 'RETURN';
      request_key: string;
      requester_id?: string;
      vehicle_plate?: string | null;
      driver_name?: string | null;
      driver_phone?: string | null;
      notes?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.createBranchTransferBatches(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.cancel_many' })
  cancelTransferBatches(
    @Payload()
    data: {
      batch_ids: string[];
      remove_order_bindings?: boolean;
      requester_id?: string;
      notes?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.cancelBranchTransferBatches(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.history.add' })
  addTransferBatchHistory(
    @Payload()
    data: {
      batch_id?: string;
      user_id?: string;
      action?: 'CREATED' | 'SENT' | 'RECEIVED' | 'CANCELLED';
      notes?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.addBranchTransferBatchHistory(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_by_id' })
  findTransferBatchById(
    @Payload() data: { id?: string; batch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findBranchTransferBatchById(data?.id ?? data?.batch_id ?? ''),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.send' })
  sendTransferBatch(
    @Payload()
    data: {
      batch_id?: string;
      vehicle_plate?: string;
      driver_name?: string;
      driver_phone?: string;
      requester_id?: string;
      requester_name?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.sendBranchTransferBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.bulk_assign_batch' })
  bulkAssignBatch(
    @Payload()
    data: {
      batch_id?: string;
      order_ids?: string[];
      message_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.bulkAssignBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.bulk_remove_from_batch' })
  bulkRemoveFromBatch(
    @Payload()
    data: {
      batch_id?: string;
      message_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.bulkRemoveFromBatch(data),
    );
  }
}
