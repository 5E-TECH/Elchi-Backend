import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { UserServiceService } from './user-service.service';
import type {
  CreateUserPayload,
  DeleteUserPayload,
  FindAllUsersPayload,
  FindUserByIdPayload,
  FindUserByUsernamePayload,
  UpdateUserPayload,
} from './contracts/user.payloads';

@Controller()
export class UserServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly userService: UserServiceService,
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

  @MessagePattern({ cmd: 'salom_ber' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      message: 'Salom! Men User Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'user.create' })
  createUser(@Payload() payload: CreateUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.createUser(payload.dto));
  }

  @MessagePattern({ cmd: 'user.update' })
  updateUser(@Payload() payload: UpdateUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.userService.updateUser(payload.id, payload.dto),
    );
  }

  @MessagePattern({ cmd: 'user.delete' })
  deleteUser(@Payload() payload: DeleteUserPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.deleteUser(payload.id));
  }

  @MessagePattern({ cmd: 'user.find_by_id' })
  getUserById(
    @Payload() payload: FindUserByIdPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.userService.findById(payload.id));
  }

  @MessagePattern({ cmd: 'user.find_by_username' })
  getUserByUsername(
    @Payload() payload: FindUserByUsernamePayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.findByUsername(payload.username),
    );
  }

  @MessagePattern({ cmd: 'user.find_all' })
  getUsers(@Payload() payload: FindAllUsersPayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.userService.findAll(payload?.query));
  }

  // Backward compatibility for old command names
  @MessagePattern({ cmd: 'create_user' })
  createUserLegacy(
    @Payload() data: { username: string; password: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.userService.createUser({ username: data.username, password: data.password }),
    );
  }

  @MessagePattern({ cmd: 'get_user_by_username' })
  getUserByUsernameLegacy(
    @Payload() data: { username: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.userService.findByUsername(data.username));
  }

  @MessagePattern({ cmd: 'get_user_by_id' })
  getUserByIdLegacy(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.userService.findById(data.id));
  }
}
