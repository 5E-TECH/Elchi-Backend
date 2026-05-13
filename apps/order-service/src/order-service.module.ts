import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderServiceController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';
import {
  RmqModule,
  DatabaseModule,
  orderValidationSchema,
  IdempotencyModule,
  OutboxModule,
} from '@app/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';
import { BranchTransferBatch } from './entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from './entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from './entities/branch-transfer-batch-history.entity';
import { OrderBatchInboxMessage } from './entities/order-batch-inbox-message.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: orderValidationSchema,
    }),
    RmqModule,
    RmqModule.register({ name: 'SEARCH' }),
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    RmqModule.register({ name: 'CATALOG' }),
    RmqModule.register({ name: 'FINANCE' }),
    RmqModule.register({ name: 'INTEGRATION' }),
    RmqModule.register({ name: 'BRANCH' }),
    DatabaseModule,
    IdempotencyModule.forService(),
    OutboxModule.forService({
      targets: ['FINANCE', 'CATALOG', 'SEARCH', 'IDENTITY', 'LOGISTICS', 'INTEGRATION', 'BRANCH'],
    }),
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      OrderTracking,
      OrderCustodyEvent,
      Branch,
      BranchTransferBatch,
      BranchTransferBatchItem,
      BranchTransferBatchHistory,
      OrderBatchInboxMessage,
    ]),
  ],
  controllers: [OrderServiceController],
  providers: [OrderServiceService],
})
export class OrderServiceModule {}
