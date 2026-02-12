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
  createUser(@Payload() payload: CreateUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.createUser(payload.dto));
  }

  @MessagePattern({ cmd: 'identity.user.update' })
  updateUser(@Payload() payload: UpdateUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.userService.updateUser(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'identity.user.delete' })
  deleteUser(@Payload() payload: DeleteUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.deleteUser(payload.id));
  }

  @MessagePattern({ cmd: 'identity.user.find_by_id' })
  getUserById(
    @Payload() payload: FindUserByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.userService.findById(payload.id));
  }

  @MessagePattern({ cmd: 'identity.user.find_by_username' })
  getUserByUsername(
    @Payload() payload: FindUserByUsernamePayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findByUsername(payload.username),
    );
  }

  @MessagePattern({ cmd: 'identity.user.find_all' })
  getUsers(@Payload() payload: FindAllUsersPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.findAll(payload?.query));
  }
}
