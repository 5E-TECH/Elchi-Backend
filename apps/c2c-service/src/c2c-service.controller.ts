import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { C2cServiceService } from './c2c-service.service';

@Controller()
export class C2cServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly c2cService: C2cServiceService,
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
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.listing.find_all' })
  findAllListings(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.listing.find_by_id' })
  findListingById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.listing.update' })
  updateListing(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- C2C Order ---
  @MessagePattern({ cmd: 'c2c.order.create' })
  createOrder(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.order.find_all' })
  findAllOrders(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.order.update_status' })
  updateOrderStatus(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- Review ---
  @MessagePattern({ cmd: 'c2c.review.create' })
  createReview(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.review.find_by_user' })
  findReviewsByUser(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- Dispute ---
  @MessagePattern({ cmd: 'c2c.dispute.open' })
  openDispute(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.dispute.resolve' })
  resolveDispute(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'c2c.dispute.find_all' })
  findAllDisputes(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }
}
