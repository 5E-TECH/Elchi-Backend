import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';
import { CreateDistrictDto } from './dto/create-district.dto';
import { UpdateDistrictDto } from './dto/update-district.dto';
import { UpdateDistrictNameDto } from './dto/update-district-name.dto';
import { UpdateDistrictSatoCodeDto } from './dto/update-district-sato-code.dto';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { ReceivePostDto } from './dto/receive-post.dto';
import { PostIdDto } from './dto/post-id.dto';
import { Post_status } from '@app/common';
import type { ActivityLogQuery } from '@app/common';
import { DistrictResolverService } from './district-resolver/district-resolver.service';
import type { DistrictResolveByTextPayload } from './district-resolver/district-resolver.types';

/**
 * CODE-12 — eski, tekshiruvsiz pochta buyruqlari ishga tushirishda O'CHIQ.
 *
 * - `logistics.post.create` — chaqiruvchisi yo'q; buyurtmalarni holat
 *   tekshiruvisiz RECEIVED qilardi;
 * - `logistics.post.update` (sendPost) — pochtani filial tekshiruvisiz istalgan
 *   kuryerga berardi va tanlanmagan buyurtmalarga RECEIVED yozardi;
 * - `logistics.post.reassign` — faqat post.courier_id ni almashtirardi,
 *   buyurtmalar custody'si eski kuryerda qolardi.
 *
 * Frontend ularni chaqirmaydi. Ish oqimlari: filialga —
 * POST /branches/posts/:postId/dispatch, kuryerga — POST
 * /orders/assign-to-courier yoki skan. Servis metodlari o'zgarmagan: qayta
 * yoqish = shu handlerlarni qaytarish.
 */
export const LEGACY_POST_COMMAND_DISABLED_MESSAGE =
  "Bu eski pochta amali o'chirilgan (buyurtma custody'sini tekshiruvsiz o'zgartirardi). Pochtani filialga POST /branches/posts/:postId/dispatch, kuryerga esa POST /orders/assign-to-courier yoki skan orqali bering";

const rejectLegacyPostCommand = (): never => {
  throw new RpcException(errorRes(LEGACY_POST_COMMAND_DISABLED_MESSAGE, 410));
};

@Controller()
export class LogisticsServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly logisticsService: LogisticsServiceService,
    private readonly districtResolver: DistrictResolverService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
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
  // CODE-12: o'chiq (yuqoridagi LEGACY_POST_COMMAND_DISABLED_MESSAGE ga qarang).
  @MessagePattern({ cmd: 'logistics.post.create' })
  createPost(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, rejectLegacyPostCommand);
  }

  @MessagePattern({ cmd: 'logistics.post.find_all' })
  findAllPosts(
    @Payload()
    data: {
      query: {
        page?: number;
        limit?: number;
        branch_id?: string;
        status?: string;
      };
      requester?: { id?: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    const requester = data?.requester
      ? {
          id: String(data.requester.id ?? ''),
          roles: data.requester.roles ?? [],
        }
      : undefined;
    return this.executeAndAck(context, () =>
      this.logisticsService.findAllPosts(
        data?.query?.page,
        data?.query?.limit,
        {
          branch_id: data?.query?.branch_id,
          status: data?.query?.status,
        },
        requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.new' })
  newPosts(
    @Payload()
    data: {
      query?: { search?: string };
      requester?: { id?: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    const requester = data?.requester
      ? {
          id: String(data.requester.id ?? ''),
          roles: data.requester.roles ?? [],
        }
      : undefined;
    return this.executeAndAck(context, () =>
      this.logisticsService.newPosts(data?.query, requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.rejected' })
  rejectedPosts(
    @Payload() data: { requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    const requester = data?.requester
      ? {
          id: String(data.requester.id ?? ''),
          roles: data.requester.roles ?? [],
        }
      : undefined;
    return this.executeAndAck(context, () =>
      this.logisticsService.rejectedPosts(requester),
    );
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
    @Payload()
    data: {
      page?: number;
      limit?: number;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.oldPostsForCourier(
        data.page ?? 1,
        data.limit ?? 8,
        data.requester,
      ),
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

  // Kuryer ko'chirish/o'chirish tekshiruvi (branch-service) uchun yengil
  // o'qish: identity boyitishsiz, har bir bekor pochta — o'z soni bilan.
  @MessagePattern({ cmd: 'logistics.post.open_return_posts_for_courier' })
  openReturnPostsForCourier(
    @Payload() data: { courier_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.openReturnPostsForCourier(data?.courier_id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.my_for_courier' })
  myPostsForCourier(
    @Payload()
    data: {
      page?: number;
      limit?: number;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.myPostsForCourier(
        data.page ?? 1,
        data.limit ?? 8,
        data.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.find_by_id' })
  findPostById(
    @Payload()
    data: { id: string; requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    const requester = data?.requester
      ? {
          id: String(data.requester.id ?? ''),
          roles: data.requester.roles ?? [],
        }
      : undefined;
    return this.executeAndAck(context, () =>
      this.logisticsService.findPostById(data.id, requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.delete' })
  deletePost(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.deletePost(data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.find_by_ids' })
  findPostsByIds(
    @Payload() data: { ids: string[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findPostsByIds(data.ids ?? []),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.find_by_scan' })
  findPostByScan(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findPostWithQr(data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.couriers_by_post' })
  couriersByPost(@Payload() data: { id: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findAllCouriersByPostId(data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.orders_by_post' })
  ordersByPost(
    @Payload()
    data: { id: string; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.getPostOrders(data.id, data.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.courier_orders_by_post' })
  courierOrdersByPost(
    @Payload()
    data: { id: string; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.getCourierSentPostOrders(data.id, data.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.rejected_orders_by_post' })
  rejectedOrdersByPost(
    @Payload()
    data: { id: string; requester?: { id?: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    const requester = data?.requester
      ? {
          id: String(data.requester.id ?? ''),
          roles: data.requester.roles ?? [],
        }
      : undefined;
    return this.executeAndAck(context, () =>
      this.logisticsService.getRejectedPostOrders(data.id, requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.check' })
  checkPost(
    @Payload() data: { id: string; dto: PostIdDto },
    @Ctx() context: RmqContext,
  ) {
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

  // CODE-12: o'chiq (sendPost — filial/holat tekshiruvisiz).
  @MessagePattern({ cmd: 'logistics.post.update' })
  updatePost(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, rejectLegacyPostCommand);
  }

  // CODE-12: o'chiq (faqat post.courier_id almashardi, custody eski kuryerda).
  @MessagePattern({ cmd: 'logistics.post.reassign' })
  reassignPost(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, rejectLegacyPostCommand);
  }

  @MessagePattern({ cmd: 'logistics.post.receive' })
  receivePost(
    @Payload()
    data: {
      id: string;
      dto: ReceivePostDto;
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receivePost(data.requester, data.id, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.receive_scan' })
  receivePostScan(
    @Payload()
    data: { id: string; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receivePostWithScanner(data.requester, data.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.receive_order' })
  receiveOrder(
    @Payload()
    data: { id: string; requester: { id: string; roles?: string[] } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receiveOrderWithScannerCourier(
        data.requester,
        data.id,
      ),
    );
  }

  @MessagePattern({ cmd: 'logistics.order.scan_assign' })
  scanAssignOrder(
    @Payload()
    data: {
      dto: { qr_token: string };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.scanAssignOrder(data.requester, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.order.assign_to_courier' })
  assignOrdersToCourier(
    @Payload()
    data: {
      dto: { order_ids: string[]; courier_id: string };
      requester: { id: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.assignOrdersToCourier(data.requester, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.cancel.create' })
  createCanceledPost(
    @Payload()
    data: {
      dto: ReceivePostDto;
      requester: { id: string; roles?: string[]; branch_id?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.createCanceledPost(data.requester, data.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.cancel.receive' })
  receiveCanceledPost(
    @Payload()
    data: {
      id: string;
      dto: ReceivePostDto;
      requester: { id: string; roles?: string[]; branch_id?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receiveCanceledPost(
        data.requester,
        data.id,
        data.dto,
      ),
    );
  }

  // Qaytarish so'rovlari so'rovchi doirasida: menejer/registrator — o'z
  // filiali, superadmin/admin (va HQ registratori) — HQ kuryerlari.
  @MessagePattern({ cmd: 'logistics.post.return_requests' })
  getReturnRequests(
    @Payload()
    data: {
      requester?: { id: string; roles?: string[]; branch_id?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.getReturnRequests(data?.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.return_requests.approve' })
  approveReturnRequests(
    @Payload()
    data: {
      dto: ReceivePostDto;
      requester?: { id: string; roles?: string[]; branch_id?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.approveReturnRequests(data.dto, data.requester),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.return_requests.reject' })
  rejectReturnRequests(
    @Payload()
    data: {
      dto: ReceivePostDto;
      requester?: { id: string; roles?: string[]; branch_id?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.rejectReturnRequests(data.dto, data.requester),
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
    return this.executeAndAck(context, () =>
      this.logisticsService.findAllRegions(),
    );
  }

  @MessagePattern({ cmd: 'logistics.region.stats_all' })
  findAllRegionStats(
    @Payload() payload: { startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.getAllRegionsStats(
        payload?.startDate,
        payload?.endDate,
      ),
    );
  }

  @MessagePattern({ cmd: 'logistics.region.stats_by_id' })
  findRegionStatsById(
    @Payload() payload: { id: string; startDate?: string; endDate?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.getRegionDetailedStats(
        payload?.id,
        payload?.startDate,
        payload?.endDate,
      ),
    );
  }

  @MessagePattern({ cmd: 'logistics.region.find_by_id' })
  findRegionById(
    @Payload() payload: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findRegionById(payload.id),
    );
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
    return this.executeAndAck(context, () =>
      this.logisticsService.deleteRegion(payload.id),
    );
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
  findAllDistricts(
    @Payload() payload: { region_id?: string } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findAllDistricts(payload?.region_id),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.find_by_id' })
  findDistrictById(
    @Payload() payload: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findDistrictById(payload.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.find_by_sato' })
  findDistrictBySatoCode(
    @Payload() payload: { sato_code: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findDistrictBySatoCode(payload.sato_code),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.update' })
  updateDistrict(
    @Payload()
    payload: {
      id: string;
      dto: UpdateDistrictDto;
      requester?: { id?: string; roles?: string[] };
    },
    @Ctx() context: RmqContext,
  ) {
    const requester = payload?.requester
      ? {
          id: String(payload.requester.id ?? ''),
          roles: payload.requester.roles ?? [],
        }
      : undefined;
    return this.executeAndAck(context, () =>
      this.logisticsService.updateDistrict(payload.id, payload.dto, requester),
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

  @MessagePattern({ cmd: 'logistics.district.update_sato' })
  updateDistrictSatoCode(
    @Payload() payload: { id: string; dto: UpdateDistrictSatoCodeDto },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.updateDistrictSatoCode(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.sato_match_preview' })
  matchDistrictSatoCodes(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.matchDistrictSatoCodes(),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.sato_match_apply' })
  applyDistrictSatoCodes(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.logisticsService.applyDistrictSatoCodes(),
    );
  }

  @MessagePattern({ cmd: 'logistics.district.delete' })
  deleteDistrict(
    @Payload() payload: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.deleteDistrict(payload.id),
    );
  }

  @MessagePattern({ cmd: 'logistics.post.receive_orders' })
  receiveOrdersIntoPosts(
    @Payload()
    data: {
      orders: Array<{
        order_id: string;
        assigned_region: string;
        total_price: number;
        assigned_branch?: string;
        assigned_post_status?: Post_status;
      }>;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.receiveOrdersIntoPosts(data.orders ?? []),
    );
  }

  // --- Batch Endpoints ---

  @MessagePattern({ cmd: 'logistics.district.find_by_ids' })
  findDistrictsByIds(
    @Payload() payload: { ids: string[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findDistrictsByIds(payload.ids ?? []),
    );
  }

  /**
   * AI buyurtma: erkin matndan viloyat + tuman (PLAN C7, karta AnKM7xmy).
   * PARTIYA shakli — bitta preview (<= 30 buyurtma) = bitta RPC, DB bir
   * marta o'qiladi. Deterministik, LLM'siz. Javob `items` tartibida.
   */
  @MessagePattern({ cmd: 'logistics.district.resolve_by_text' })
  resolveDistrictsByText(
    @Payload() payload: DistrictResolveByTextPayload | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => {
      const items = payload?.items;
      if (!Array.isArray(items)) return successRes([]);
      return this.districtResolver.resolveBatch(items);
    });
  }

  @MessagePattern({ cmd: 'logistics.region.find_by_ids' })
  findRegionsByIds(
    @Payload() payload: { ids: string[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.findRegionsByIds(payload.ids ?? []),
    );
  }

  // --- Activity log (read) ---
  @MessagePattern({ cmd: 'logistics.activity_log.find_all' })
  activityLogFindAll(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'logistics.activity_log.find_by_entity' })
  activityLogFindByEntity(
    @Payload() data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.logisticsService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
