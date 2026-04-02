import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { FileServiceService } from './file-service.service';
import { UploadFileDto } from './dto/upload-file.dto';
import { GetFileUrlDto } from './dto/get-file-url.dto';
import { DeleteFileDto } from './dto/delete-file.dto';
import { GenerateQrDto } from './dto/generate-qr.dto';
import { GeneratePdfDto } from './dto/generate-pdf.dto';

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
  upload(@Payload() data: UploadFileDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.fileService.upload(data));
  }

  @MessagePattern({ cmd: 'file.get_url' })
  getUrl(@Payload() data: GetFileUrlDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.fileService.getUrl(data));
  }

  @MessagePattern({ cmd: 'file.delete' })
  remove(@Payload() data: DeleteFileDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.fileService.remove(data));
  }

  @MessagePattern({ cmd: 'file.generate_qr' })
  generateQr(@Payload() data: GenerateQrDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.fileService.generateQr(data));
  }

  @MessagePattern({ cmd: 'file.generate_pdf' })
  generatePdf(@Payload() data: GeneratePdfDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.fileService.generatePdf(data));
  }
}
