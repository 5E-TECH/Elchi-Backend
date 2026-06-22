import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  RmqService,
  executeAndAck,
  IdempotencyService,
  executeIdempotent,
  ActivityLogQuery,
} from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import { OrderServiceService } from './order-service.service';
import { OrderHolderType, Order_source } from './entities/order.entity';

@Controller()
export class OrderServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly orderService: OrderServiceService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  private runIdempotent<T>(
    context: RmqContext,
    pattern: string,
    requestId: string | undefined,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeIdempotent(
      this.rmqService,
      this.idempotencyService,
      context,
      { requestId, pattern },
      handler,
    );
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
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeIdempotent(
      this.rmqService,
      this.idempotencyService,
      context,
      { requestId: data.request_id, pattern: 'order.create' },
      () => this.orderService.create(data.dto, data.requester),
    );
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
        canceled_post_unassigned?: boolean;
        holder_type?: OrderHolderType;
        qr_code_token?: string;
        status?: Order_status | Order_status[] | string | string[];
        return_requested?: boolean;
        start_day?: string;
        end_day?: string;
        courier?: string;
        courier_ids?: string[];
        region_id?: string;
        district_id?: string;
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
    return this.executeAndAck(context, () =>
      this.orderService.findAll(data.query),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_id' })
  findById(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.findById(data.id),
    );
  }

  @MessagePattern({ cmd: 'order.branch_can_delete' })
  branchCanDelete(
    @Payload() data: { branch_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.branchCanDelete(data?.branch_id),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_qr' })
  findByQr(@Payload() data: { token: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.findByQrCode(data.token),
    );
  }

  @MessagePattern({ cmd: 'order.find_by_qr_enriched' })
  findByQrEnriched(
    @Payload() data: { token: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findByQrCodeEnriched(data.token),
    );
  }

  @MessagePattern({ cmd: 'order.tracking' })
  tracking(
    @Payload() data: { id: string; page?: number; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getTrackingByOrderId(data.id, data.page, data.limit),
    );
  }

  @MessagePattern({ cmd: 'order.custody_history' })
  custodyHistory(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.getCustodyHistoryByOrderId(data.id),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_markets' })
  findNewMarkets(
    @Payload()
    data: { branch_id?: string; exclude_branch_source?: boolean } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewMarkets(
        data?.branch_id,
        Boolean(data?.exclude_branch_source),
      ),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_by_market' })
  findNewByMarket(
    @Payload()
    data: {
      market_id: string;
      branch_id?: string;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewOrdersByMarket(
        data.market_id,
        data.branch_id,
        Boolean(data?.exclude_branch_source),
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
      dto: {
        comment?: string;
        extraCost?: number;
        paidAmount?: number;
        proofFileKeys?: string[];
        proofFileKeysVerified?: boolean;
      };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(context, 'order.sell', data.request_id, () =>
      this.orderService.sellOrder(
        data.requester,
        data.id,
        data.dto ?? {},
        data.request_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.cancel' })
  cancel(
    @Payload()
    data: {
      id: string;
      dto: {
        comment?: string;
        extraCost?: number;
        proofFileKeys?: string[];
        proofFileKeysVerified?: boolean;
      };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(context, 'order.cancel', data.request_id, () =>
      this.orderService.cancelOrder(
        data.requester,
        data.id,
        data.dto ?? {},
        data.request_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.could_not_deliver' })
  couldNotDeliver(
    @Payload()
    data: {
      id: string;
      dto: { reason?: string };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.could_not_deliver',
      data.request_id,
      () =>
        this.orderService.couldNotDeliverOrder(
          data.requester,
          data.id,
          data.dto ?? {},
        ),
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
        proofFileKeys?: string[];
        proofFileKeysVerified?: boolean;
      };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.partly_sell',
      data.request_id,
      () =>
        this.orderService.partlySellOrder(
          data.requester,
          data.id,
          data.dto,
          data.request_id,
        ),
    );
  }

  @MessagePattern({ cmd: 'order.rollback_waiting' })
  rollbackToWaiting(
    @Payload()
    data: {
      id: string;
      requester: { id: string; roles?: string[] };
      dto?: { target_status?: 'waiting' | 'cancelled' | 'cancelled_sent' };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.rollback_waiting',
      data.request_id,
      () =>
        this.orderService.rollbackOrderToWaiting(
          data.requester,
          data.id,
          data.dto,
          data.request_id,
        ),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.courier_to_branch' })
  settlementCourierToBranch(
    @Payload()
    data: {
      dto: { courier_id: string; amount: number };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.courier_to_branch',
      data.request_id,
      () => this.orderService.settleCourierToBranch(data.requester, data.dto),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.branch_to_hq' })
  settlementBranchToHq(
    @Payload()
    data: {
      dto: { branch_id: string; amount: number };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.branch_to_hq',
      data.request_id,
      () => this.orderService.settleBranchToHq(data.requester, data.dto),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.hq_to_market' })
  settlementHqToMarket(
    @Payload()
    data: {
      dto: { market_id: string; amount: number };
      requester: { id: string; roles?: string[] };
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.hq_to_market',
      data.request_id,
      () => this.orderService.settleHqToMarket(data.requester, data.dto),
    );
  }

  // State-only FIFO advance, called by the gateway right after a production
  // finance.cashbox.payment_* succeeds, so order_settlement tracks which orders'
  // COD reached which level (keeps the rollback guard accurate). (Audit I1/I2.)
  @MessagePattern({ cmd: 'order.settlement.advance' })
  settlementAdvance(
    @Payload()
    data: {
      level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market';
      match_value: string;
      amount: number;
      requester_id?: string;
      request_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.runIdempotent(
      context,
      'order.settlement.advance',
      data.request_id,
      () => this.orderService.advanceSettlement(data),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.find_by_order' })
  settlementFindByOrder(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getSettlementByOrderId(data.id),
    );
  }

  @MessagePattern({ cmd: 'order.settlement.financial_balance_summary' })
  settlementFinancialBalanceSummary(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.orderService.getFinancialBalanceSettlementSummary(),
    );
  }

  @MessagePattern({ cmd: 'order.initiate_return' })
  initiateReturn(
    @Payload()
    data: {
      id: string;
      dto: { reason?: string };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.initiateReturn(data.requester, data.id, data.dto ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.mark_returned_to_market' })
  markReturnedToMarket(
    @Payload()
    data: {
      id: string;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.markReturnedToMarket(data.requester, data.id),
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
    @Payload()
    data: { id: string; requester?: { id?: string; roles?: string[] } },
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
  findNewMarketsEnriched(
    @Payload()
    data: { branch_id?: string; exclude_branch_source?: boolean } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewMarketsEnriched(
        data?.branch_id,
        Boolean(data?.exclude_branch_source),
      ),
    );
  }

  @MessagePattern({ cmd: 'order.find_new_by_market_enriched' })
  findNewByMarketEnriched(
    @Payload()
    data: {
      market_id: string;
      branch_id?: string;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findNewByMarketEnriched(
        data.market_id,
        data.branch_id,
        Boolean(data?.exclude_branch_source),
      ),
    );
  }

  @MessagePattern({ cmd: 'order.find_cancelled_markets_enriched' })
  findCancelledMarketsEnriched(
    @Payload()
    data: {
      market_id?: string;
      branch_id?: string;
      holder_type?: OrderHolderType;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findCancelledMarketsEnriched({
        market_id: data?.market_id,
        branch_id: data?.branch_id,
        holder_type: data.holder_type,
        exclude_branch_source: Boolean(data?.exclude_branch_source),
      }),
    );
  }

  @MessagePattern({ cmd: 'order.find_cancelled_by_market_enriched' })
  findCancelledByMarketEnriched(
    @Payload()
    data: {
      market_id: string;
      branch_id?: string;
      holder_type?: OrderHolderType;
      exclude_branch_source?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findCancelledByMarketEnriched(data.market_id, {
        branch_id: data?.branch_id,
        holder_type: data.holder_type,
        exclude_branch_source: Boolean(data?.exclude_branch_source),
      }),
    );
  }

  @MessagePattern({ cmd: 'order.market_cancelled_handover.create_qr' })
  createMarketCancelledHandoverQr(
    @Payload()
    data: {
      market_id: string;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.createMarketCancelledHandoverQr(data),
    );
  }

  @MessagePattern({ cmd: 'order.market_cancelled_handover.scan_qr' })
  scanMarketCancelledHandoverQr(
    @Payload()
    data: {
      qr_token: string;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.scanMarketCancelledHandoverQr(data),
    );
  }

  @MessagePattern({ cmd: 'order.market_cancelled_handover.complete' })
  completeMarketCancelledHandover(
    @Payload()
    data: {
      market_id: string;
      order_ids: string[];
      authorization_token: string;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.completeMarketCancelledHandover(data),
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
      return this.orderService.updateFull(
        data.id,
        normalized as any,
        data.requester,
      );
    });
  }

  @MessagePattern({ cmd: 'order.analytics.overview' })
  analyticsOverview(
    @Payload()
    data: {
      startDate?: string;
      endDate?: string;
      branch_id?: string;
      all?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getOverviewStats(
        data.startDate,
        data.endDate,
        data.branch_id,
        data.all,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.market_stats' })
  analyticsMarketStats(
    @Payload()
    data: { startDate?: string; endDate?: string; branch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getMarketStats(
        data.startDate,
        data.endDate,
        data.branch_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.courier_stats' })
  analyticsCourierStats(
    @Payload()
    data: { startDate?: string; endDate?: string; branch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getCourierStats(
        data.startDate,
        data.endDate,
        data.branch_id,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_markets' })
  analyticsTopMarkets(
    @Payload() data: { limit?: number; branch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getTopMarkets(data.limit, data.branch_id),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.top_couriers' })
  analyticsTopCouriers(
    @Payload() data: { limit?: number; branch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getTopCouriers(data.limit, data.branch_id),
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
    @Payload()
    data: { requester: { id: string }; startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getCourierStat(
        data.requester.id,
        data.startDate,
        data.endDate,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.market_stat' })
  analyticsMarketStat(
    @Payload()
    data: { requester: { id: string }; startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getMarketStat(
        data.requester.id,
        data.startDate,
        data.endDate,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.analytics.revenue' })
  analyticsRevenue(
    @Payload() data: { startDate?: string; endDate?: string; period?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.getRevenueStats(
        data.startDate,
        data.endDate,
        data.period,
      ),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.create' })
  createTransferBatch(
    @Payload()
    data: {
      source_branch_id: string;
      destination_branch_id: string;
      order_ids?: string[];
      direction?: 'FORWARD' | 'RETURN';
      request_key: string;
      requester_id?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.createBranchTransferBatches(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.create_return' })
  createReturnTransferBatch(
    @Payload()
    data: {
      source_branch_id: string;
      order_ids: string[];
      request_key: string;
      requester_id?: string;
      notes?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.createBranchReturnBatches(data),
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
      this.orderService.findBranchTransferBatchById(
        data?.id ?? data?.batch_id ?? '',
      ),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_all' })
  findTransferBatches(
    @Payload()
    data: {
      source_branch_id?: string;
      destination_branch_id?: string;
      status?: string;
      direction?: string;
      period?: string;
      date?: string;
      page?: number;
      limit?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findBranchTransferBatches(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_branches_with_sent' })
  findBranchesWithSentTransferBatches(
    @Payload()
    data: {
      direction?: string;
      side?: 'source' | 'destination' | string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findBranchesWithSentTransferBatches(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.send' })
  sendTransferBatch(
    @Payload()
    data: {
      batch_id?: string;
      order_ids?: string[];
      orderIds?: string[];
      vehicle_plate?: string;
      driver_name?: string;
      driver_phone?: string;
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.sendBranchTransferBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_remaining' })
  findRemainingTransferBatchItems(
    @Payload() data: { id?: string; batch_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findRemainingBranchTransferBatchItems(
        data?.id ?? data?.batch_id ?? '',
      ),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.receive' })
  receiveTransferBatch(
    @Payload()
    data: {
      batch_id?: string;
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.receiveBranchTransferBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.receive_orders' })
  receiveTransferBatchOrders(
    @Payload()
    data: {
      batch_id?: string;
      order_ids?: string[];
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.receiveBranchTransferBatchOrders(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.cancel' })
  cancelTransferBatchSingle(
    @Payload()
    data: {
      batch_id?: string;
      reason?: string;
      requester_id?: string;
      requester_name?: string;
      requester_roles?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.cancelBranchTransferBatch(data),
    );
  }

  @MessagePattern({ cmd: 'order.transfer_batch.find_by_qr' })
  findTransferBatchByQr(
    @Payload() data: { token?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findBranchTransferBatchByQrToken(
        String(data?.token ?? '').trim(),
      ),
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

  // Status-only terminal transition reported by an external delivery provider
  // (no cashbox movement — see OrderServiceService.markByProvider).
  @MessagePattern({ cmd: 'order.provider.mark' })
  markByProvider(
    @Payload()
    data: {
      order_id: string;
      action: 'sell' | 'cancel' | 'return';
      provider_slug?: string | null;
      external_ref?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.markByProvider(data),
    );
  }

  // Enriched, render-ready rows for label / receipt printing (gateway renders
  // the PDF/HTML). Cross-service batch resolution lives in the service layer.
  @MessagePattern({ cmd: 'order.print.find' })
  findOrdersForPrint(
    @Payload() data: { order_ids: string[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.findOrdersForPrint(data?.order_ids ?? []),
    );
  }

  @MessagePattern({ cmd: 'order.activity_log.find_all' })
  activityLogFindAll(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'order.activity_log.find_by_entity' })
  activityLogFindByEntity(
    @Payload()
    data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
