import { RpcException } from '@nestjs/microservices';
import { OrderServiceService } from './order-service.service';

describe('OrderServiceService transfer batch scan', () => {
  function setup() {
    const transferBatchRepo = {
      findOne: jest.fn(),
    };
    const transferBatchItemRepo = {
      find: jest.fn(),
    };

    // OrderServiceService konstruktori — 16 ta pozitsion bog'liqlik.
    const service = new OrderServiceService(
      { createQueryRunner: jest.fn() } as any, // dataSource
      {} as any, // orderRepo
      {} as any, // orderItemRepo
      {} as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      {} as any, // orderSettlementRepo
      transferBatchRepo as any, // transferBatchRepo
      transferBatchItemRepo as any, // transferBatchItemRepo
      {} as any, // transferBatchHistoryRepo
      {} as any, // searchClient
      {} as any, // identityClient
      {} as any, // logisticsClient
      {} as any, // catalogClient
      {} as any, // financeClient
      {} as any, // integrationClient
      {} as any, // branchClient
      {} as any, // fileClient
      {} as any, // outbox
    );

    return { service, transferBatchRepo, transferBatchItemRepo };
  }

  it('findBranchTransferBatchByQrToken returns batch with items', async () => {
    const { service, transferBatchRepo, transferBatchItemRepo } = setup();
    transferBatchRepo.findOne.mockResolvedValue({
      id: '700',
      qr_code_token: 'BTB-token',
      source_branch_id: '10',
    });
    transferBatchItemRepo.find.mockResolvedValue([
      { id: '1', order_id: '900', snapshot_price: 120000, snapshot_market_id: '11' },
    ]);

    const res: any = await service.findBranchTransferBatchByQrToken('BTB-token');

    expect(res.statusCode).toBe(200);
    expect(res.data.id).toBe('700');
    expect(res.data.items).toHaveLength(1);
  });

  it('findBranchTransferBatchByQrToken throws 404 when token not found', async () => {
    const { service, transferBatchRepo } = setup();
    transferBatchRepo.findOne.mockResolvedValue(null);

    await expect(service.findBranchTransferBatchByQrToken('BTB-missing')).rejects.toBeInstanceOf(
      RpcException,
    );
  });
});
