import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext, RpcException } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { errorRes } from '../../../libs/common/helpers/response';
import { C2cServiceService } from './c2c-service.service';

@Controller()
export class C2cServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly c2cService: C2cServiceService,
  ) {}

  private notImplemented(): never {
    throw new RpcException(
      errorRes('C2C functionality is not implemented yet', 501),
    );
  }

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

  @MessagePattern({ cmd: 'c2c.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'c2c-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  // --- Listing ---
  @MessagePattern({ cmd: 'c2c.listing.create' })
  createListing(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.listing.find_all' })
  findAllListings(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.listing.find_by_id' })
  findListingById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.listing.update' })
  updateListing(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  // --- C2C Order ---
  @MessagePattern({ cmd: 'c2c.order.create' })
  createOrder(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.order.find_all' })
  findAllOrders(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.order.update_status' })
  updateOrderStatus(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  // --- Review ---
  @MessagePattern({ cmd: 'c2c.review.create' })
  createReview(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.review.find_by_user' })
  findReviewsByUser(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  // --- Dispute ---
  @MessagePattern({ cmd: 'c2c.dispute.open' })
  openDispute(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.dispute.resolve' })
  resolveDispute(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }

  @MessagePattern({ cmd: 'c2c.dispute.find_all' })
  findAllDisputes(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.notImplemented());
  }
}
