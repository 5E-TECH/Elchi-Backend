import { RpcException } from '@nestjs/microservices';
import { OrderServiceService } from './order-service.service';
import { Order } from './entities/order.entity';
import { OrderBatchInboxMessage } from './entities/order-batch-inbox-message.entity';

describe('OrderServiceService bulk batch handlers', () => {
  function createSetup(options?: { affected?: number; duplicateMessage?: boolean }) {
    const affected = options?.affected ?? 2;
    const duplicateMessage = options?.duplicateMessage ?? false;

    const updateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected }),
    };

    const orderRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(updateQb),
    };

    const inboxRepo = {
      create: jest.fn((payload) => payload),
      insert: duplicateMessage
        ? jest.fn().mockRejectedValue({ code: '23505' })
        : jest.fn().mockResolvedValue({ identifiers: [{ id: '1' }] }),
    };

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === Order.name) return orderRepo;
          if (entity.name === OrderBatchInboxMessage.name) return inboxRepo;
          return {};
        }),
      },
    };

    const service = new OrderServiceService(
      { createQueryRunner: jest.fn(() => queryRunner) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, queryRunner, orderRepo, inboxRepo, updateQb };
  }

  it('bulkAssignBatch assigns all orders in one transaction', async () => {
    const { service, queryRunner, updateQb } = createSetup({ affected: 2 });

    const res: any = await service.bulkAssignBatch({
      batch_id: '100',
      order_ids: ['1', '2'],
      message_id: 'msg_assign_0001',
    });

    expect(updateQb.set).toHaveBeenCalledWith({ current_batch_id: '100' });
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(res.data.idempotent).toBe(false);
    expect(res.data.affected).toBe(2);
  });

  it('bulkAssignBatch rolls back when not all orders are updated', async () => {
    const { service, queryRunner } = createSetup({ affected: 1 });

    await expect(
      service.bulkAssignBatch({
        batch_id: '100',
        order_ids: ['1', '2'],
        message_id: 'msg_assign_0002',
      }),
    ).rejects.toBeInstanceOf(RpcException);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('bulkAssignBatch ignores duplicated message id (idempotent)', async () => {
    const { service, queryRunner, orderRepo } = createSetup({ duplicateMessage: true });

    const res: any = await service.bulkAssignBatch({
      batch_id: '100',
      order_ids: ['1', '2'],
      message_id: 'msg_assign_dup',
    });

    expect(orderRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(res.data.idempotent).toBe(true);
  });

  it('bulkAssignBatch processes same message id only once', async () => {
    const { service, orderRepo, inboxRepo } = createSetup({ affected: 2 });

    inboxRepo.insert = jest
      .fn()
      .mockResolvedValueOnce({ identifiers: [{ id: '1' }] })
      .mockRejectedValueOnce({ code: '23505' });

    await service.bulkAssignBatch({
      batch_id: '100',
      order_ids: ['1', '2'],
      message_id: 'msg_assign_same_10x',
    });

    const second: any = await service.bulkAssignBatch({
      batch_id: '100',
      order_ids: ['1', '2'],
      message_id: 'msg_assign_same_10x',
    });

    expect(orderRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(second.data.idempotent).toBe(true);
  });

  it('bulkRemoveFromBatch clears current_batch_id for all matched orders', async () => {
    const { service, updateQb } = createSetup({ affected: 3 });

    const res: any = await service.bulkRemoveFromBatch({
      batch_id: '100',
      message_id: 'msg_remove_0001',
    });

    expect(updateQb.set).toHaveBeenCalledWith({ current_batch_id: null });
    expect(res.data.idempotent).toBe(false);
    expect(res.data.affected).toBe(3);
  });
});
