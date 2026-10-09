import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderServiceController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';
import { OrderAnalyticsService } from './analytics/order-analytics.service';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderLookupService } from './lookup/order-lookup.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderCustodyService } from './custody/order-custody.service';
import { OrderNotificationService } from './notification/order-notification.service';
import { ProductResolverService } from './ai/product-resolver.service';
import { AiPreviewService } from './ai/ai-preview.service';
import {
  PRODUCT_DISAMBIGUATOR,
  RmqProductDisambiguator,
} from './ai/product-disambiguator';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  orderValidationSchema,
  IdempotencyModule,
  OutboxModule,
  ActivityLogModule,
} from '@app/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';
import { Branch } from './entities/branch.entity';
import { BranchTransferBatch } from './entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from './entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from './entities/branch-transfer-batch-history.entity';
import { OrderBatchInboxMessage } from './entities/order-batch-inbox-message.entity';
import { MarketCancelledHandoverSession } from './entities/market-cancelled-handover-session.entity';
import { OrderExtraCostApproval } from './entities/order-extra-cost-approval.entity';

import { CustomerSegmentService } from './segment/customer-segment.service';
import { CustomerSegmentController } from './segment/customer-segment.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: orderValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'order-service' }),
    RmqModule,
    RmqModule.register({ name: 'SEARCH' }),
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    RmqModule.register({ name: 'CATALOG' }),
    RmqModule.register({ name: 'FINANCE' }),
    RmqModule.register({ name: 'INTEGRATION' }),
    RmqModule.register({ name: 'BRANCH' }),
    RmqModule.register({ name: 'FILE' }),
    // `ai.product.disambiguate` (noaniq mahsulotni LLM bilan aniqlashtirish) —
    // ai-service navbati. Faqat RPC mijozi; outbox maqsadi EMAS.
    RmqModule.register({ name: 'AI' }),
    // (OA16fdSq) Buyurtma hodisalari → `notification.dispatch`. FAQAT outbox
    // maqsadi sifatida (OrderNotificationService) — to'g'ridan-to'g'ri
    // rmqSend TAQIQ (tranzaksiya rollback bo'lsa ham xabar ketib qolardi).
    RmqModule.register({ name: 'NOTIFICATION' }),
    DatabaseModule,
    IdempotencyModule.forService(),
    OutboxModule.forService({
      targets: [
        'FINANCE',
        'CATALOG',
        'SEARCH',
        'IDENTITY',
        'LOGISTICS',
        'INTEGRATION',
        'BRANCH',
        'NOTIFICATION',
      ],
      // (OA16fdSq) Bildirishnoma javobi KUTILMAYDI: dispatch Telegram'ni ham
      // kutadi (10 s gacha), notification-service yiqilsa esa har hodisa
      // timeout'gacha osilardi — ketma-ket publisher'da ortidagi PUL
      // hodisalari kechikardi. Pul/holat hodisalari bu ro'yxatda YO'Q.
      options: { fireAndForgetPatterns: ['notification.dispatch'] },
    }),
    ActivityLogModule.forService('order-service'),
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      OrderTracking,
      OrderCustodyEvent,
      OrderSettlement,
      OrderSettlementCarry,
      Branch,
      BranchTransferBatch,
      BranchTransferBatchItem,
      BranchTransferBatchHistory,
      OrderBatchInboxMessage,
      MarketCancelledHandoverSession,
      OrderExtraCostApproval,
    ]),
  ],
  controllers: [OrderServiceController, CustomerSegmentController],
  providers: [
    CustomerSegmentService,
    OrderServiceService,
    OrderAnalyticsService,
    BranchTransferBatchService,
    OrderSettlementService,
    OrderLookupService,
    OrderLifecycleService,
    OrderCustodyService,
    OrderNotificationService,
    ProductResolverService,
    AiPreviewService,
    { provide: PRODUCT_DISAMBIGUATOR, useClass: RmqProductDisambiguator },
  ],
})
export class OrderServiceModule {}
