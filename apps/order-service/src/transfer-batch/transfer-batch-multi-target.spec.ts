import { RpcException } from '@nestjs/microservices';
import { getMetadataArgsStorage } from 'typeorm';
import { BranchTransferDirection, Order_status } from '@app/common';
import { BranchTransferBatchService } from './branch-transfer-batch.service';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';

/**
 * Filial paketi bitta so'rovda bir necha viloyatga bo'linadi (staging
 * 2026-11-14: 5 viloyatli «Qabul qilish» → 502). Haqiqiy Postgres'dagi
 * tekshiruv — `transfer-batch-multi-target.pg.spec.ts` (lokal bazada); bu
 * fayl CI'da yuradigan qismi:
 *  - entity yagonaligi so'rov + manzil + viloyat (eski `(source, request_key)`
 *    qaytmasin);
 *  - yagonalik buzilsa (parallel takroriy so'rov) — 409, xom 23505 emas
 *    (branch-service uni 502 «Buyurtmalar xizmati javob bermadi» qilardi).
 */
describe('filial paketi — bir so‘rovda bir necha viloyat', () => {
  it('entity: request_key yagonaligi — manba + kalit + manzil + viloyat', () => {
    const unique = getMetadataArgsStorage()
      .indices.filter(
        (index) => index.target === BranchTransferBatch && index.unique,
      )
      .map((index) => ({ name: index.name, columns: index.columns }));

    expect(unique).toContainEqual({
      name: 'UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET',
      columns: [
        'source_branch_id',
        'request_key',
        'destination_branch_id',
        'target_region_id',
      ],
    });
    expect(unique.map((index) => index.name)).not.toContain(
      'UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY',
    );
  });

  function makeHarness(saveError: unknown) {
    const batchRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn().mockRejectedValue(saveError),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) =>
          entity.name === 'BranchTransferBatch' ? batchRepo : {},
        ),
      },
    };
    const orders = ['11', '12', '13', '14', '15'].map((region, index) => ({
      id: String(495 + index),
      region_id: region,
      market_id: '3',
      total_price: 520000,
      status: Order_status.NEW,
    }));
    const service = new BranchTransferBatchService(
      { createQueryRunner: jest.fn(() => queryRunner) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      {} as never,
      { find: jest.fn().mockResolvedValue(orders) } as never,
      {} as never,
      {} as never,
      { log: jest.fn() } as never,
      { auditActor: jest.fn(() => ({})) } as never,
    );
    const create = () =>
      service.createBranchTransferBatches({
        source_branch_id: '10',
        destination_branch_id: '1',
        direction: BranchTransferDirection.FORWARD,
        order_ids: orders.map((order) => order.id),
        request_key: 'req_parallel_duplicate',
        requester_id: '25',
      });
    return { create, queryRunner };
  }

  it('yagonalik buzilsa (23505) — 409 va tranzaksiya qaytariladi', async () => {
    const duplicate = Object.assign(
      new Error('duplicate key value violates unique constraint'),
      { code: '23505' },
    );
    const { create, queryRunner } = makeHarness(duplicate);

    const error = await create().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('boshqa baza xatosi — o‘zgarmay o‘tadi', async () => {
    const broken = Object.assign(new Error('connection terminated'), {
      code: '57P01',
    });
    const { create } = makeHarness(broken);

    await expect(create()).rejects.toBe(broken);
  });
});
