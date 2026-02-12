import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { FileServiceService } from './file-service.service';

@Controller()
export class FileServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly fileService: FileServiceService,
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

  @MessagePattern({ cmd: 'file.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'file-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'file.upload' })
  upload(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'file.get_url' })
  getUrl(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'file.delete' })
  remove(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'file.generate_qr' })
  generateQr(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }

  @MessagePattern({ cmd: 'file.generate_pdf' })
  generatePdf(@Payload() data: any, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({ message: 'not implemented' }));
  }
}
