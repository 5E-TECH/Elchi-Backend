import { Test, TestingModule } from '@nestjs/testing';
import { RmqService, IdempotencyService } from '@app/common';
import { OrderServiceController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';
import { OrderAnalyticsService } from './analytics/order-analytics.service';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

describe('OrderServiceController', () => {
  let orderServiceController: OrderServiceController;
  let rmqService: { ack: jest.Mock };

  beforeEach(async () => {
    rmqService = { ack: jest.fn() };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [OrderServiceController],
      providers: [
        {
          provide: RmqService,
          useValue: rmqService,
        },
        {
          provide: OrderServiceService,
          useValue: {},
        },
        {
          provide: OrderAnalyticsService,
          useValue: {},
        },
        {
          provide: BranchTransferBatchService,
          useValue: {},
        },
        {
          provide: OrderSettlementService,
          useValue: {},
        },
        {
          provide: OrderLifecycleService,
          useValue: {},
        },
        {
          provide: IdempotencyService,
          useValue: {},
        },
      ],
    }).compile();

    orderServiceController = app.get<OrderServiceController>(
      OrderServiceController,
    );
  });

  describe('health', () => {
    it('should return service health payload and ack message', async () => {
      const ctx = {} as any;
      const res = await orderServiceController.health(ctx);

      expect(res).toHaveProperty('message', 'Salom! Men Order Service man.');
      expect(res).toHaveProperty('status', 'Hammasi chotki ishlayapti!');
      expect(rmqService.ack).toHaveBeenCalledWith(ctx);
    });
  });
});
