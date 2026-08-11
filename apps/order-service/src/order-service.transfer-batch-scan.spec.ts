import { RpcException } from '@nestjs/microservices';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';

describe('BranchTransferBatchService transfer batch scan', () => {
  function setup() {
    const transferBatchRepo = {
      findOne: jest.fn(),
    };
    const transferBatchItemRepo = {
      find: jest.fn(),
    };

    // BranchTransferBatchService(dataSource, transferBatchRepo,
    // transferBatchItemRepo, transferBatchHistoryRepo, orderRepo,
    // orderTrackingRepo, orderCustodyEventRepo, activityLog).
    const service = new BranchTransferBatchService(
      { createQueryRunner: jest.fn() } as any, // dataSource
      transferBatchRepo as any, // transferBatchRepo
      transferBatchItemRepo as any, // transferBatchItemRepo
      {} as any, // transferBatchHistoryRepo
      {} as any, // orderRepo
      {} as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({
          items: [],
          meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
        }),
        findByEntity: jest.fn().mockResolvedValue([]),
        findByUser: jest.fn().mockResolvedValue([]),
      } as any, // activityLog
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
