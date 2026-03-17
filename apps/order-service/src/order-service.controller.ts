import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import { OrderServiceService } from './order-service.service';

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
      return await handler();
    } finally {
      this.rmqService.ack(context);
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
        post_id?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.create(data.dto));
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
        status?: Order_status;
        start_day?: string;
        end_day?: string;
        courier?: string;
        region_id?: string;
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
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        canceled_post_id?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    // Backward compatibility: old pattern now supports full update payload too.
    return this.executeAndAck(context, () =>
      this.orderService.updateFull(data.id, data.dto),
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
        comment?: string | null;
        operator?: string | null;
        post_id?: string | null;
        canceled_post_id?: string | null;
        district_id?: string | null;
        region_id?: string | null;
        address?: string | null;
        qr_code_token?: string | null;
        items?: Array<{ product_id: string; quantity?: number }>;
      };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.orderService.updateFull(data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'order.delete' })
  remove(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.remove(data.id));
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
    @Payload() data: { id: string; dto: Record<string, any> },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => {
      const normalized = this.orderService.normalizeUpdatePayload(data.dto);
      return this.orderService.updateFull(data.id, normalized as any);
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
}
