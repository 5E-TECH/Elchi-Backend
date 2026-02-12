import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

@Controller()
export class LogisticsServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly logisticsService: LogisticsServiceService,
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

  @MessagePattern({ cmd: 'logistics.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'logistics-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  // --- Post ---
  @MessagePattern({ cmd: 'logistics.post.create' })
  createPost(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => {
      // TODO: implement
      return { message: 'not implemented' };
    });
  }

  @MessagePattern({ cmd: 'logistics.post.find_all' })
  findAllPosts(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'logistics.post.find_by_id' })
  findPostById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'logistics.post.update' })
  updatePost(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- Region ---
  @MessagePattern({ cmd: 'logistics.region.create' })
  createRegion(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'logistics.region.find_all' })
  findAllRegions(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'logistics.region.find_by_id' })
  findRegionById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  // --- District ---
  @MessagePattern({ cmd: 'logistics.district.create' })
  createDistrict(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'logistics.district.find_all' })
  findAllDistricts(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'logistics.district.find_by_id' })
  findDistrictById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }
}
