import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import type { ActivityLogQuery } from '@app/common';
import {
  UserServiceService,
  type GeoReassignInput,
} from './user-service.service';
import { AuthService } from './auth/auth.service';
import { OtpService } from './otp/otp.service';
import type { OtpRequestInput, OtpVerifyInput } from './otp/otp.service';
import type {
  CreateCustomerPayload,
  CreateCourierPayload,
  CreateUserPayload,
  DeleteUserPayload,
  FindAllUsersPayload,
  FindCouriersByIdsPayload,
  FindUserByIdPayload,
  CreateManagerPayload,
  SetCourierRegionPayload,
  UpdateUserStatusPayload,
  UpdateUserPayload,
} from './contracts/user.payloads';
import type {
  CreateMarketPayload,
  DeleteMarketPayload,
  FindAllMarketsPayload,
  FindMarketByIdPayload,
  FindMarketByTgTokenPayload,
  FindMarketsByIdsPayload,
  GetMarketTgTokenPayload,
  RotateAllMarketTgTokensPayload,
  RotateMarketTgTokenPayload,
  UpdateMarketPayload,
} from './contracts/market.payloads';
import type {
  CreateMarketOperatorPayload,
  DeleteMarketOperatorPayload,
  FindMarketOperatorsPayload,
  UpdateMarketOperatorCommissionPayload,
} from './contracts/market-operator.payloads';

@Controller()
export class IdentityController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly userService: UserServiceService,
    private readonly authService: AuthService,
    private readonly otpService: OtpService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  // ==================== Health ====================

  @MessagePattern({ cmd: 'identity.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      message: 'Salom! Men Identity Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    }));
  }

  // ==================== Auth ====================

  @MessagePattern({ cmd: 'identity.login' })
  login(
    @Payload() data: { phone_number: string; password: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.authService.login(data));
  }

  @MessagePattern({ cmd: 'identity.refresh' })
  refresh(
    @Payload() data: { refreshToken: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.authService.refresh(data));
  }

  @MessagePattern({ cmd: 'identity.logout' })
  logout(@Payload() data: { userId: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.authService.logout(data.userId),
    );
  }

  @MessagePattern({ cmd: 'identity.validate' })
  validate(@Payload() data: { userId: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.authService.validateUser(data.userId),
    );
  }

  // ==================== User CRUD ====================

  @MessagePattern({ cmd: 'identity.user.create' })
  createAdmin(
    @Payload() payload: CreateUserPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createAdmin(payload.dto, payload.requester),
    );
  }

  @MessagePattern({ cmd: 'identity.registrator.create' })
  createRegistrator(
    @Payload() payload: CreateUserPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createRegistrator(payload.dto, payload.requester),
    );
  }

  // (dzyVftBx) POST /logists.
  @MessagePattern({ cmd: 'identity.logist.create' })
  createLogist(
    @Payload() payload: CreateUserPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createLogist(payload.dto, payload.requester),
    );
  }

  // (dzyVftBx) Ichki: logistics viloyatga logist biriktirishdan oldin.
  @MessagePattern({ cmd: 'identity.logist.find_by_ids' })
  getLogistsByIds(
    @Payload() payload: { ids?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findLogistsByIds(payload?.ids),
    );
  }

  @MessagePattern({ cmd: 'identity.courier.create' })
  createCourier(
    @Payload() payload: CreateCourierPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createCourier(payload.dto, payload.requester),
    );
  }

  @MessagePattern({ cmd: 'identity.manager.create' })
  createManager(
    @Payload() payload: CreateManagerPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createManager(payload.dto, payload.requester),
    );
  }

  @MessagePattern({ cmd: 'identity.courier.find_all' })
  getCouriers(
    @Payload() payload: FindAllUsersPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findAllCouriers(payload?.query),
    );
  }

  @MessagePattern({ cmd: 'identity.customer.create' })
  createCustomer(
    @Payload() payload: CreateCustomerPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createCustomer(payload.dto),
    );
  }

  @MessagePattern({ cmd: 'identity.user.update' })
  updateAdmin(
    @Payload() payload: UpdateUserPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.updateUser(payload.id, payload.dto, payload.requester),
    );
  }

  /**
   * Ichki: branch-service kuryerni boshqa filialga o'tkazganda (yoki
   * o'tkazishni bekor qilganda) kuryer hududini filial hududiga moslaydi.
   * Gateway'da bu RPC'ga HTTP route yo'q. `deadline_at` o'zgarishsiz uzatiladi
   * (servis faqat chekli son bo'lsa hisobga oladi).
   */
  @MessagePattern({ cmd: 'identity.courier.set_region' })
  setCourierRegion(
    @Payload() payload: SetCourierRegionPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.setCourierRegion(
        payload.id,
        payload.region_id ?? null,
        payload.requester,
        payload.deadline_at,
      ),
    );
  }

  @MessagePattern({ cmd: 'identity.user.delete' })
  deleteAdmin(
    @Payload() payload: DeleteUserPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.deleteUser(payload.id, payload.requester),
    );
  }

  /** OTP so'rash (rkz0yBxr) — javob raqam mavjudligidan qat'i nazar bir xil. */
  @MessagePattern({ cmd: 'identity.otp.request' })
  otpRequest(@Payload() payload: OtpRequestInput, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.otpService.request(payload));
  }

  @MessagePattern({ cmd: 'identity.otp.verify' })
  otpVerify(@Payload() payload: OtpVerifyInput, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.otpService.verify(payload));
  }

  /** SMS/push yetkazish uchun telefon/rol/til — notification-service chaqiradi. */
  @MessagePattern({ cmd: 'identity.user.contacts_by_ids' })
  contactsByIds(
    @Payload() payload: { ids?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.contactsByIds(payload?.ids),
    );
  }

  // oNAE3LW9: hudud o'chirish himoyasi va tumanlarni birlashtirish.
  @MessagePattern({ cmd: 'identity.user.geo_usage' })
  geoUsage(
    @Payload() payload: { district_id?: string; region_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.countGeoUsage(payload ?? {}),
    );
  }

  // Ko'chgan ID'larni qaytaradi; `ids` + `restore_regions` — kompensatsiya.
  @MessagePattern({ cmd: 'identity.user.reassign_district' })
  geoReassignDistrict(
    @Payload() payload: GeoReassignInput,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.reassignDistrict(payload ?? {}),
    );
  }

  @MessagePattern({ cmd: 'identity.user.find_by_id' })
  getAdminById(
    @Payload() payload: FindUserByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    // (GvL6ZFAd) market_tg_token bu yerda HECH QACHON qaytmaydi: eski
    // `include_tg_token` flagi kelsa ham e'tiborsiz — faqat id uzatiladi.
    // Token: identity.market.get_tg_token (faqat SUPERADMIN).
    // (i76gGjyq) `include_deleted` faqat qat'iy `true` bilan (ichki finance).
    return this.executeAndAck(context, () =>
      this.userService.findUserById(payload.id, {
        includeDeleted: payload?.include_deleted === true,
      }),
    );
  }

  @MessagePattern({ cmd: 'identity.user.profile' })
  getMyProfile(
    @Payload() payload: FindUserByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findOwnProfile(payload.id),
    );
  }

  @MessagePattern({ cmd: 'identity.me.update_settings' })
  updateOwnSettings(
    @Payload()
    payload: { id: string; settings: Record<string, unknown> | null },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.updateOwnSettings(payload.id, payload.settings),
    );
  }

  @MessagePattern({ cmd: 'identity.customer.find_by_id' })
  getCustomerById(
    @Payload() payload: FindUserByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findCustomerById(payload.id),
    );
  }

  @MessagePattern({ cmd: 'identity.user.find_all' })
  getAdmins(
    @Payload() payload: FindAllUsersPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findAllAdmins(payload?.query),
    );
  }

  @MessagePattern({ cmd: 'identity.user.status' })
  updateUserStatus(
    @Payload() payload: UpdateUserStatusPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.setUserStatus(
        payload.id,
        payload.status,
        payload.requester,
      ),
    );
  }

  // ==================== Market CRUD ====================

  @MessagePattern({ cmd: 'identity.market.create' })
  createMarket(
    @Payload() payload: CreateMarketPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createMarket(payload.dto, payload.requester),
    );
  }

  @MessagePattern({ cmd: 'identity.market.update' })
  updateMarket(
    @Payload() payload: UpdateMarketPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.updateMarket(payload.id, payload.dto, payload.requester),
    );
  }

  @MessagePattern({ cmd: 'identity.market.delete' })
  deleteMarket(
    @Payload() payload: DeleteMarketPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.deleteMarket(payload.id),
    );
  }

  @MessagePattern({ cmd: 'identity.market.find_by_id' })
  getMarketById(
    @Payload() payload: FindMarketByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findMarketById(payload.id),
    );
  }

  @MessagePattern({ cmd: 'identity.market.find_by_ids' })
  getMarketsByIds(
    @Payload() payload: FindMarketsByIdsPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findMarketsByIds(payload.ids),
    );
  }

  @MessagePattern({ cmd: 'identity.market.find_all' })
  getMarkets(
    @Payload() payload: FindAllMarketsPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findAllMarkets(payload?.query),
    );
  }

  @MessagePattern({ cmd: 'identity.market.find_by_tg_token' })
  getMarketByTgToken(
    @Payload() payload: FindMarketByTgTokenPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findMarketByTelegramToken(payload.market_tg_token),
    );
  }

  // (GvL6ZFAd) market_tg_token'ni ko'rish/almashtirish — faqat SUPERADMIN
  // (gateway RolesGuard + servisdagi requester.roles tekshiruvi).

  @MessagePattern({ cmd: 'identity.market.get_tg_token' })
  getMarketTgToken(
    @Payload() payload: GetMarketTgTokenPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.getMarketTelegramToken(payload?.id, payload?.requester),
    );
  }

  @MessagePattern({ cmd: 'identity.market.rotate_tg_token' })
  rotateMarketTgToken(
    @Payload() payload: RotateMarketTgTokenPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.rotateMarketTelegramToken(
        payload?.id,
        payload?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'identity.market.rotate_all_tg_tokens' })
  rotateAllMarketTgTokens(
    @Payload() payload: RotateAllMarketTgTokensPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.rotateAllMarketTelegramTokens(
        payload?.confirm,
        payload?.requester,
      ),
    );
  }

  // ==================== Market operators (i76gGjyq) ====================
  // market_id gateway'da qo'yiladi (market — JWT sub); servis uni requester
  // bilan qayta solishtiradi.

  @MessagePattern({ cmd: 'identity.market_operator.create' })
  createMarketOperator(
    @Payload() payload: CreateMarketOperatorPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createMarketOperator(
        payload?.market_id,
        payload?.dto,
        payload?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'identity.market_operator.find_by_market' })
  findMarketOperators(
    @Payload() payload: FindMarketOperatorsPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findMarketOperators(
        payload?.market_id,
        payload?.query,
        payload?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'identity.market_operator.delete' })
  deleteMarketOperator(
    @Payload() payload: DeleteMarketOperatorPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.deleteMarketOperator(
        payload?.id,
        payload?.market_id,
        payload?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: 'identity.market_operator.update_commission' })
  updateMarketOperatorCommission(
    @Payload() payload: UpdateMarketOperatorCommissionPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.updateMarketOperatorCommission(
        payload?.id,
        payload?.market_id,
        payload?.dto,
        payload?.requester,
      ),
    );
  }

  // ==================== Batch Endpoints ====================

  @MessagePattern({ cmd: 'identity.customer.find_by_ids' })
  getCustomersByIds(
    @Payload() payload: { ids: string[] },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findCustomersByIds(payload.ids ?? []),
    );
  }

  // (2WRzdWpZ audit-actor-name) Ichki: gateway faoliyat jurnali actor/entity
  // ismlari uchun. find_all'dan farqli — superadmin ham qaytadi.
  @MessagePattern({ cmd: 'identity.user.find_by_ids' })
  getUsersByIds(
    @Payload() payload: { ids?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findUsersByIds(payload?.ids),
    );
  }

  @MessagePattern({ cmd: 'identity.courier.find_by_ids' })
  getCouriersByIds(
    @Payload() payload: FindCouriersByIdsPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findCouriersByIds(payload.ids ?? []),
    );
  }

  @MessagePattern({ cmd: 'identity.customer.search' })
  searchCustomers(
    @Payload() payload: { search: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.searchCustomers(payload.search, payload.limit),
    );
  }

  // ==================== Activity log (read) ====================

  @MessagePattern({ cmd: 'identity.activity_log.find_all' })
  activityLogFindAll(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'identity.activity_log.find_by_entity' })
  activityLogFindByEntity(
    @Payload()
    data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
