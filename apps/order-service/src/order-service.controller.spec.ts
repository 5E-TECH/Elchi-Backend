import { Test, TestingModule } from '@nestjs/testing';
import { RmqService, IdempotencyService } from '@app/common';
import { OrderServiceController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';
import { OrderAnalyticsService } from './analytics/order-analytics.service';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { AiPreviewService } from './ai/ai-preview.service';

describe('OrderServiceController', () => {
  let orderServiceController: OrderServiceController;
  let rmqService: { ack: jest.Mock };
  let analytics: {
    getMarketStats: jest.Mock;
    getCourierStats: jest.Mock;
    getTopMarkets: jest.Mock;
    getTopBranches: jest.Mock;
    getMarketStat: jest.Mock;
  };

  beforeEach(async () => {
    rmqService = { ack: jest.fn() };
    analytics = {
      getMarketStats: jest.fn().mockResolvedValue([]),
      getCourierStats: jest.fn().mockResolvedValue([]),
      getTopMarkets: jest.fn().mockResolvedValue([]),
      getTopBranches: jest.fn().mockResolvedValue([]),
      getMarketStat: jest.fn().mockResolvedValue({}),
    };

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
          useValue: analytics,
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
        {
          provide: AiPreviewService,
          useValue: { resolve: jest.fn() },
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

  it('uN1tjjGu: all=true ni barcha dashboard RMQ handlerlariga uzatadi', async () => {
    const ctx = {} as any;
    const range = {
      startDate: '1970-01-01',
      endDate: '2026-10-12',
      all: true,
    };
    await orderServiceController.analyticsMarketStats(range, ctx);
    await orderServiceController.analyticsCourierStats(range, ctx);
    await orderServiceController.analyticsTopMarkets(range, ctx);
    await orderServiceController.analyticsTopBranches(range, ctx);
    await orderServiceController.analyticsMarketStat(
      { ...range, requester: { id: '4' } },
      ctx,
    );

    expect(analytics.getMarketStats).toHaveBeenCalledWith(
      range.startDate,
      range.endDate,
      undefined,
      true,
    );
    expect(analytics.getCourierStats).toHaveBeenCalledWith(
      range.startDate,
      range.endDate,
      undefined,
      true,
    );
    expect(analytics.getTopMarkets).toHaveBeenCalledWith(
      undefined,
      undefined,
      range.startDate,
      range.endDate,
      undefined,
      undefined,
      true,
    );
    expect(analytics.getTopBranches).toHaveBeenCalledWith(
      undefined,
      undefined,
      range.startDate,
      range.endDate,
      undefined,
      undefined,
      true,
    );
    expect(analytics.getMarketStat).toHaveBeenCalledWith(
      '4',
      range.startDate,
      range.endDate,
      true,
    );
  });
});
