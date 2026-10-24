import { RpcException } from '@nestjs/microservices';
import { BranchTransferBatchService } from './branch-transfer-batch.service';

/**
 * 3HKvAyhm — `order.transfer_batch.history.find`: paket tarixini o'qish
 * (ilgari faqat `history.add` bor edi). Xronologik, o'chirilgan paket — 404.
 */
type HistoryResult = {
  statusCode: number;
  data: Array<{ id: string; action: string; notes: string | null }>;
};

function setup(batch: { id: string } | null) {
  const transferBatchRepo = { findOne: jest.fn().mockResolvedValue(batch) };
  const historyRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: '11',
        batch_id: '601',
        user_id: '25',
        action: 'CREATED',
        notes: null,
        created_at: new Date('2026-10-24T08:00:00Z'),
      },
      {
        id: '12',
        batch_id: '601',
        user_id: '25',
        action: 'SENT',
        notes: undefined,
        created_at: new Date('2026-10-24T09:00:00Z'),
      },
    ]),
  };
  const service = new BranchTransferBatchService(
    {} as never,
    transferBatchRepo as never,
    {} as never,
    historyRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, transferBatchRepo, historyRepo };
}

describe('3HKvAyhm — order.transfer_batch.history.find', () => {
  it('⭐ paket tarixi xronologik (created_at, id ASC), notes null bo‘lib', async () => {
    const { service, historyRepo, transferBatchRepo } = setup({ id: '601' });
    const res = (await service.findBranchTransferBatchHistory(
      ' 601 ',
    )) as HistoryResult;
    expect(res.statusCode).toBe(200);
    expect(res.data.map((row) => row.action)).toEqual(['CREATED', 'SENT']);
    expect(res.data[1].notes).toBeNull();
    expect(historyRepo.find).toHaveBeenCalledWith({
      where: { batch_id: '601' },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    expect(transferBatchRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: '601', isDeleted: false } }),
    );
  });

  it('paket yo‘q / o‘chirilgan → 404; id bo‘sh → 400', async () => {
    const statusOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return undefined;
      } catch (e) {
        return e instanceof RpcException
          ? (e.getError() as { statusCode?: number }).statusCode
          : undefined;
      }
    };
    const { service, historyRepo } = setup(null);
    expect(await statusOf(service.findBranchTransferBatchHistory('601'))).toBe(
      404,
    );
    expect(await statusOf(service.findBranchTransferBatchHistory(''))).toBe(
      400,
    );
    expect(historyRepo.find).not.toHaveBeenCalled();
  });
});
