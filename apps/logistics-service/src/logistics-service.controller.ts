import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';
import { CreateDistrictDto } from './dto/create-district.dto';
import { UpdateDistrictDto } from './dto/update-district.dto';
import { UpdateDistrictNameDto } from './dto/update-district-name.dto';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { successRes } from '../../../libs/common/helpers/response';

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
    return this.executeAndAck(context, () =>
      successRes(
        {
          service: 'logistics-service',
          status: 'ok',
          timestamp: new Date().toISOString(),
        },
        200,
        'success',
      ),
    );
  }

  // --- Post ---
  @MessagePattern({ cmd: 'logistics.post.create' })
  createPost(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => {
      // TODO: implement
      return successRes({ message: 'not implemented' }, 200, 'success');
    });
  }

  @MessagePattern({ cmd: 'logistics.post.find_all' })
  findAllPosts(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      successRes({ message: 'not implemented' }, 200, 'success'),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.find_by_id' })
  findPostById(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      successRes({ message: 'not implemented' }, 200, 'success'),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.update' })
  updatePost(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      successRes({ message: 'not implemented' }, 200, 'success'),
    );
  }

  // --- Region ---
  @MessagePattern({ cmd: 'logistics.region.create' })
  createRegion(
    @Payload() payload: { dto: CreateRegionDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.createRegion(payload.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.region.find_all' })
  findAllRegions(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.findAllRegions());
  }

  @MessagePattern({ cmd: 'logistics.region.find_by_id' })
  findRegionById(@Payload() payload: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.findRegionById(payload.id));
  }

  @MessagePattern({ cmd: 'logistics.region.update' })
  updateRegion(
    @Payload() payload: { id: string; dto: UpdateRegionDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.updateRegion(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.region.delete' })
  deleteRegion(@Payload() payload: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.deleteRegion(payload.id));
  }

  // --- District ---
  @MessagePattern({ cmd: 'logistics.district.create' })
  createDistrict(
    @Payload() payload: { dto: CreateDistrictDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.createDistrict(payload.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.find_all' })
  findAllDistricts(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.findAllDistricts());
  }

  @MessagePattern({ cmd: 'logistics.district.find_by_id' })
  findDistrictById(@Payload() payload: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findDistrictById(payload.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.update' })
  updateDistrict(
    @Payload() payload: { id: string; dto: UpdateDistrictDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.updateDistrict(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.update_name' })
  updateDistrictName(
    @Payload() payload: { id: string; dto: UpdateDistrictNameDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.updateDistrictName(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.delete' })
  deleteDistrict(@Payload() payload: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.deleteDistrict(payload.id),
    );
  }
}
