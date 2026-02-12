import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { CatalogServiceService } from './catalog-service.service';

@Controller()
export class CatalogServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly catalogService: CatalogServiceService,
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

  @MessagePattern({ cmd: 'catalog.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      message: 'Salom! Men Catalog Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'catalog.product.create' })
  create(
    @Payload() data: { dto: { name: string; user_id: string; image_url?: string } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.catalogService.create(data.dto));
  }

  @MessagePattern({ cmd: 'catalog.product.find_all' })
  findAll(
    @Payload() data: { query: { user_id?: string; search?: string; page?: number; limit?: number } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.catalogService.findAll(data.query));
  }

  @MessagePattern({ cmd: 'catalog.product.find_by_id' })
  findById(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.catalogService.findById(data.id));
  }

  @MessagePattern({ cmd: 'catalog.product.update' })
  update(
    @Payload() data: { id: string; dto: { name?: string; image_url?: string } },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.catalogService.update(data.id, data.dto));
  }

  @MessagePattern({ cmd: 'catalog.product.delete' })
  remove(
    @Payload() data: { id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.catalogService.remove(data.id));
  }
}
