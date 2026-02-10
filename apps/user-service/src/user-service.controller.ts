import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';

@Controller()
export class UserServiceController {
  constructor(private readonly rmqService: RmqService) {}

  @MessagePattern({ cmd: 'salom_ber' }) // 1. Shu buyruqni kutadi
  async handleSalom(@Ctx() context: RmqContext) {
    this.rmqService.ack(context); // 2. Xabarni oldim deb tasdiqlaydi (ACK)
    
    // 3. Javob qaytaradi
    return {
      message: 'Salom! Men User Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    };
  }
}