import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './outbox-event.entity';
import { OutboxService } from './outbox.service';
import { OutboxPublisher } from './outbox.publisher';
import { OUTBOX_OPTIONS, OUTBOX_TARGETS, OutboxOptions } from './tokens';

export interface OutboxModuleOptions {
  /** RMQ client tokens this service publishes to (e.g. ['FINANCE','CATALOG']). Must already be registered in the host module. */
  targets: string[];
  options?: OutboxOptions;
}

@Module({})
export class OutboxModule {
  static forService(opts: OutboxModuleOptions): DynamicModule {
    return {
      module: OutboxModule,
      imports: [TypeOrmModule.forFeature([OutboxEvent])],
      providers: [
        OutboxService,
        OutboxPublisher,
        { provide: OUTBOX_TARGETS, useValue: opts.targets },
        { provide: OUTBOX_OPTIONS, useValue: opts.options ?? {} },
      ],
      exports: [OutboxService, TypeOrmModule],
    };
  }
}
