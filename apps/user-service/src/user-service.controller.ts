import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { UserServiceService } from './user-service.service';

@Controller()
export class UserServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly userService: UserServiceService,
  ) {}

  @MessagePattern({ cmd: 'salom_ber' })
  async handleSalom(@Ctx() context: RmqContext) {
    this.rmqService.ack(context);

    return {
      message: 'Salom! Men User Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    };
  }

  @MessagePattern({ cmd: 'create_user' })
  async createUser(
    @Payload() data: { username: string; password: string },
    @Ctx() context: RmqContext,
  ) {
    this.rmqService.ack(context);
    return this.userService.createUser(data.username, data.password);
  }

  @MessagePattern({ cmd: 'get_user_by_username' })
  async getUserByUsername(
    @Payload() data: { username: string },
    @Ctx() context: RmqContext,
  ) {
    this.rmqService.ack(context);
    return this.userService.findByUsername(data.username);
  }

  @MessagePattern({ cmd: 'get_user_by_id' })
  async getUserById(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    this.rmqService.ack(context);
    return this.userService.findById(data.id);
  }
}
