import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { SearchServiceService } from './search-service.service';

@Controller()
export class SearchServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly searchService: SearchServiceService,
  ) {}

  private async executeAndAck<T>(context: RmqContext, handler: () => Promise<T> | T): Promise<T> {
    try {
      return await handler();
    } finally {
      this.rmqService.ack(context);
    }
  }

  @MessagePattern({ cmd: 'search.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      message: 'Salom! Men Search Service man.',
      status: 'Hammasi chotki ishlayapti!',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'search.index.upsert' })
  upsert(
    @Payload() payload: {
      source: string;
      type: string;
      sourceId: string;
      title: string;
      content?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.searchService.upsert(payload));
  }

  @MessagePattern({ cmd: 'search.index.remove' })
  remove(
    @Payload() payload: { source: string; type: string; sourceId: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.searchService.remove(payload));
  }

  @MessagePattern({ cmd: 'search.query' })
  query(
    @Payload() payload: { q?: string; type?: string; source?: string; page?: number; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => this.searchService.query(payload));
  }
}
