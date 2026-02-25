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
        status?: Order_status;
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

  @MessagePattern({ cmd: 'order.find_today_markets' })
  findTodayMarkets(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.orderService.findTodayMarkets());
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

  @MessagePattern({ cmd: 'order.update' })
  update(
    @Payload()
    data: {
      id: string;
      dto: {
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
    return this.executeAndAck(context, () =>
      this.orderService.update(data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'order.delete' })
  remove(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.orderService.remove(data.id));
  }
}
