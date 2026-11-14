import { RpcException } from '@nestjs/microservices';
import { getMetadataArgsStorage } from 'typeorm';
import {
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
} from '@app/common';
import { BranchTransferBatchService } from './branch-transfer-batch.service';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';

/**
 * Filial paketi (FORWARD) — bitta yo'nalishga BITTA umumiy paket, barcha
 * viloyatlar birga (Dilshod 2026-11-14, /batches: «paketlar hamma viloyatniki
 * umumiy 1 ta bo'lishi kerak, alohida-alohida emas»). Ilgari har viloyatga
 * alohida paket ochilardi va 5 viloyatli «Qabul qilish» 502 berardi.
 * Haqiqiy Postgres'dagi tekshiruv — `transfer-batch-multi-target.pg.spec.ts`
 * (lokal bazada, migratsiyalar bilan); bu fayl CI'da yuradigan qismi.
 */
describe('filial paketi — barcha viloyatlar bitta paketda', () => {
  it('entity: yo‘nalishga bitta PENDING filial paketi, viloyat NULL bo‘la oladi', () => {
    const storage = getMetadataArgsStorage();
    const unique = storage.indices
      .filter((index) => index.target === BranchTransferBatch && index.unique)
      .map((index) => ({
        name: index.name,
        columns: index.columns,
        where: index.where,
      }));

    expect(unique).toContainEqual({
      name: 'UQ_BRANCH_TRANSFER_BATCHES_PENDING_FORWARD_ROUTE',
      columns: ['source_branch_id', 'destination_branch_id'],
      where: `"status" = 'PENDING' AND "direction" = 'FORWARD' AND "is_deleted" = false`,
    });
    expect(unique).toContainEqual(
      expect.objectContaining({
        name: 'UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET',
        columns: [
          'source_branch_id',
          'request_key',
          'destination_branch_id',
          'target_region_id',
        ],
      }),
    );
    expect(unique.map((index) => index.name)).not.toContain(
      'UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY',
    );
    const targetRegion = storage.columns.find(
      (column) =>
        column.target === BranchTransferBatch &&
        column.propertyName === 'target_region_id',
    );
    expect(targetRegion?.options.nullable).toBe(true);
  });

  const ORDERS = ['11', '12', '13', '14', '15'].map((region, index) => ({
    id: String(495 + index),
    region_id: region,
    market_id: '3',
    total_price: 520000,
    status: Order_status.NEW,
  }));

  function makeHarness(opts: {
    pending?: Record<string, unknown> | null;
    saveError?: Error;
  }) {
    const savedBatches: Array<Record<string, unknown>> = [];
    const batchRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
      save: jest.fn((value: Record<string, unknown>) => {
        if (opts.saveError) return Promise.reject(opts.saveError);
        const saved = { id: value.id ?? '700', ...value };
        savedBatches.push({ ...saved });
        return Promise.resolve(saved);
      }),
    };
    if (opts.pending) {
      batchRepo.findOne.mockResolvedValueOnce(opts.pending);
    }
    const orderUpdate = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: ORDERS.length }),
    };
    const itemRepo = {
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const historyRepo = {
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === 'BranchTransferBatch') return batchRepo;
          if (entity.name === 'BranchTransferBatchItem') return itemRepo;
          if (entity.name === 'BranchTransferBatchHistory') return historyRepo;
          if (entity.name === 'Order')
            return { createQueryBuilder: jest.fn(() => orderUpdate) };
          return {};
        }),
      },
    };
    const regionQb: Record<string, jest.Mock> = {
      getRawMany: jest.fn().mockResolvedValue(
        ORDERS.map((order) => ({
          batch_id: '700',
          region_id: order.region_id,
        })),
      ),
    };
    for (const step of [
      'select',
      'addSelect',
      'distinct',
      'innerJoin',
      'where',
      'andWhere',
    ]) {
      regionQb[step] = jest.fn(() => regionQb);
    }
    const service = new BranchTransferBatchService(
      { createQueryRunner: jest.fn(() => queryRunner) } as never,
      {
        find: jest.fn(({ where }: { where: { id?: unknown } }) =>
          Promise.resolve(where.id ? [savedBatches.at(-1)] : []),
        ),
      } as never,
      {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => regionQb),
      } as never,
      {} as never,
      { find: jest.fn().mockResolvedValue(ORDERS) } as never,
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
        order_ids: ORDERS.map((order) => order.id),
        request_key: 'req_five_regions',
        requester_id: '25',
      }) as Promise<{
        statusCode: number;
        data: { batches: Array<{ id: string; region_ids: string[] }> };
      }>;
    return {
      create,
      queryRunner,
      batchRepo,
      orderUpdate,
      itemRepo,
      savedBatches,
    };
  }

  it('⭐ 5 viloyatdagi 5 ta buyurtma — bitta yangi paket, viloyatsiz, hammasi biriktiriladi', async () => {
    const h = makeHarness({});

    const res = await h.create();

    expect(res.statusCode).toBe(201);
    expect(h.batchRepo.create).toHaveBeenCalledTimes(1);
    expect(h.batchRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_branch_id: '10',
        destination_branch_id: '1',
        target_region_id: null,
        status: BranchTransferBatchStatus.PENDING,
      }),
    );
    expect(h.orderUpdate.execute).toHaveBeenCalledTimes(1);
    expect(h.orderUpdate.set).toHaveBeenCalledWith({ current_batch_id: '700' });
    expect(h.itemRepo.save).toHaveBeenCalledWith(
      ORDERS.map((order) =>
        expect.objectContaining({ batch_id: '700', order_id: order.id }),
      ),
    );
    expect(h.savedBatches.at(-1)).toMatchObject({
      order_count: 5,
      total_price: 5 * 520000,
      target_region_id: null,
    });
    expect(res.data.batches).toHaveLength(1);
    expect(res.data.batches[0].region_ids).toEqual([
      '11',
      '12',
      '13',
      '14',
      '15',
    ]);
    expect(h.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('yo‘nalishda PENDING paket bor (eski — viloyatli) — o‘shanga qo‘shiladi, yangi paket ochilmaydi', async () => {
    const h = makeHarness({
      pending: {
        id: '640',
        source_branch_id: '10',
        destination_branch_id: '1',
        direction: BranchTransferDirection.FORWARD,
        status: BranchTransferBatchStatus.PENDING,
        target_region_id: '11',
        order_count: 2,
        total_price: 900000,
      },
    });

    await h.create();

    expect(h.batchRepo.create).not.toHaveBeenCalled();
    expect(h.batchRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source_branch_id: '10',
          destination_branch_id: '1',
          status: BranchTransferBatchStatus.PENDING,
        }),
      }),
    );
    expect(h.orderUpdate.set).toHaveBeenCalledWith({ current_batch_id: '640' });
    expect(h.savedBatches.at(-1)).toMatchObject({
      id: '640',
      order_count: 7,
      total_price: 900000 + 5 * 520000,
      target_region_id: null,
    });
  });

  it('yagonalik buzilsa (parallel so‘rov, 23505) — 409 va tranzaksiya qaytariladi', async () => {
    const duplicate = Object.assign(
      new Error('duplicate key value violates unique constraint'),
      { code: '23505' },
    );
    const h = makeHarness({ saveError: duplicate });

    const error = await h.create().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(h.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(h.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('boshqa baza xatosi — o‘zgarmay o‘tadi', async () => {
    const broken = Object.assign(new Error('connection terminated'), {
      code: '57P01',
    });
    const h = makeHarness({ saveError: broken });

    await expect(h.create()).rejects.toBe(broken);
  });
});
