import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { UserServiceService } from './user-service.service';
import { AuthService } from './auth/auth.service';
import type {
  CreateCustomerPayload,
  CreateCourierPayload,
  CreateUserPayload,
  DeleteUserPayload,
  FindAllUsersPayload,
  FindUserByIdPayload,
  UpdateUserStatusPayload,
  UpdateUserPayload,
} from './contracts/user.payloads';
import type {
  CreateMarketPayload,
  DeleteMarketPayload,
  FindAllMarketsPayload,
  FindMarketByIdPayload,
  UpdateMarketPayload,
} from './contracts/market.payloads';

@Controller()
export class IdentityController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly userService: UserServiceService,
    private readonly authService: AuthService,
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
  logout(
    @Payload() data: { userId: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.authService.logout(data.userId));
  }

  @MessagePattern({ cmd: 'identity.validate' })
  validate(
    @Payload() data: { userId: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.authService.validateUser(data.userId));
  }

  // ==================== User CRUD ====================

  @MessagePattern({ cmd: 'identity.user.create' })
  createAdmin(@Payload() payload: CreateUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.createAdmin(payload.dto));
  }

  @MessagePattern({ cmd: 'identity.courier.create' })
  createCourier(@Payload() payload: CreateCourierPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.createCourier(payload.dto));
  }

  @MessagePattern({ cmd: 'identity.customer.create' })
  createCustomer(@Payload() payload: CreateCustomerPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.createCustomer(payload.dto));
  }

  @MessagePattern({ cmd: 'identity.user.update' })
  updateAdmin(@Payload() payload: UpdateUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.userService.updateUser(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'identity.user.delete' })
  deleteAdmin(@Payload() payload: DeleteUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.deleteUser(payload.id));
  }

  @MessagePattern({ cmd: 'identity.user.find_by_id' })
  getAdminById(
    @Payload() payload: FindUserByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.userService.findUserById(payload.id));
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
  getAdmins(@Payload() payload: FindAllUsersPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.findAllAdmins(payload?.query));
  }

  @MessagePattern({ cmd: 'identity.user.status' })
  updateUserStatus(
    @Payload() payload: UpdateUserStatusPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.setUserStatus(payload.id, payload.status),
    );
  }

  // ==================== Market CRUD ====================

  @MessagePattern({ cmd: 'identity.market.create' })
  createMarket(@Payload() payload: CreateMarketPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.createMarket(payload.dto));
  }

  @MessagePattern({ cmd: 'identity.market.update' })
  updateMarket(@Payload() payload: UpdateMarketPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.userService.updateMarket(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'identity.market.delete' })
  deleteMarket(@Payload() payload: DeleteMarketPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.deleteMarket(payload.id));
  }

  @MessagePattern({ cmd: 'identity.market.find_by_id' })
  getMarketById(
    @Payload() payload: FindMarketByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.userService.findUserById(payload.id));
  }

  @MessagePattern({ cmd: 'identity.market.find_all' })
  getMarkets(@Payload() payload: FindAllMarketsPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.findAllMarkets(payload?.query));
  }
}
