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
import { CreatePostDto } from './dto/create-post.dto';
import { SendPostDto } from './dto/send-post.dto';
import { ReceivePostDto } from './dto/receive-post.dto';
import { PostIdDto } from './dto/post-id.dto';

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
  createPost(@Payload() data: { dto: CreatePostDto }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.createPost(data.dto));
  }

  @MessagePattern({ cmd: 'logistics.post.find_all' })
  findAllPosts(
    @Payload() data: { query: { page?: number; limit?: number } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findAllPosts(data?.query?.page, data?.query?.limit),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.new' })
  newPosts(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.newPosts());
  }

  @MessagePattern({ cmd: 'logistics.post.rejected' })
  rejectedPosts(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.rejectedPosts());
  }

  @MessagePattern({ cmd: 'logistics.post.on_the_road' })
  onTheRoadPosts(
    @Payload() data: { requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.onTheRoadPosts(data.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.old_for_courier' })
  oldPostsForCourier(
    @Payload() data: { page?: number; limit?: number; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.oldPostsForCourier(data.page ?? 1, data.limit ?? 8, data.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.rejected_for_courier' })
  rejectedPostsForCourier(
    @Payload() data: { requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.rejectedPostsForCourier(data.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.find_by_id' })
  findPostById(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.findPostById(data.id));
  }

  @MessagePattern({ cmd: 'logistics.post.find_by_scan' })
  findPostByScan(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.logisticsService.findPostWithQr(data.id));
  }

  @MessagePattern({ cmd: 'logistics.post.couriers_by_post' })
  couriersByPost(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findAllCouriersByPostId(data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.orders_by_post' })
  ordersByPost(
    @Payload() data: { id: string; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.getPostOrders(data.id, data.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.rejected_orders_by_post' })
  rejectedOrdersByPost(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.getRejectedPostOrders(data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.check' })
  checkPost(@Payload() data: { id: string; dto: PostIdDto }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.checkPost(data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.check_cancel' })
  checkCanceledPost(
    @Payload() data: { id: string; dto: PostIdDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.checkCancelPost(data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.update' })
  updatePost(
    @Payload() data: { id: string; dto: SendPostDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.sendPost(data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.receive' })
  receivePost(
    @Payload() data: { id: string; dto: ReceivePostDto; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receivePost(data.requester, data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.receive_scan' })
  receivePostScan(
    @Payload() data: { id: string; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receivePostWithScanner(data.requester, data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.receive_order' })
  receiveOrder(
    @Payload() data: { id: string; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receiveOrderWithScannerCourier(data.requester, data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.cancel.create' })
  createCanceledPost(
    @Payload() data: { dto: ReceivePostDto; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.createCanceledPost(data.requester, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.cancel.receive' })
  receiveCanceledPost(
    @Payload() data: { id: string; dto: ReceivePostDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receiveCanceledPost(data.id, data.dto),
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
