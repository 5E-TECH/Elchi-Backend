import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from './idempotency-key.entity';
import { IdempotencyService } from './idempotency.service';

@Module({})
export class IdempotencyModule {
  static forService(): DynamicModule {
    return {
      module: IdempotencyModule,
      imports: [TypeOrmModule.forFeature([IdempotencyKey])],
      providers: [IdempotencyService],
      exports: [IdempotencyService, TypeOrmModule],
    };
  }
}
