import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { UserServiceService } from './user-service.service';
import { AuthService } from './auth/auth.service';
import type {
  CreateUserPayload,
  DeleteUserPayload,
  FindAllUsersPayload,
  FindUserByIdPayload,
  FindUserByUsernamePayload,
  UpdateUserPayload,
} from './contracts/user.payloads';

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

  @MessagePattern({ cmd: 'identity.register' })
  register(
    @Payload() data: { username: string; phone_number: string; password: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.authService.register(data));
  }

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

  @MessagePattern({ cmd: 'identity.user.update' })
  updateAdmin(@Payload() payload: UpdateUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.userService.updateAdmin(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'identity.user.delete' })
  deleteAdmin(@Payload() payload: DeleteUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.deleteAdmin(payload.id));
  }

  @MessagePattern({ cmd: 'identity.user.find_by_id' })
  getAdminById(
    @Payload() payload: FindUserByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.userService.findAdminById(payload.id));
  }

  @MessagePattern({ cmd: 'identity.user.find_by_username' })
  getAdminByUsername(
    @Payload() payload: FindUserByUsernamePayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findAdminByUsername(payload.username),
    );
  }

  @MessagePattern({ cmd: 'identity.user.find_all' })
  getAdmins(@Payload() payload: FindAllUsersPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.findAllAdmins(payload?.query));
  }
}
