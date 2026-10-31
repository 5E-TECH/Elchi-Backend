import {
  IdempotencyService,
  IDEMPOTENCY_KEY_MISMATCH_MESSAGE,
} from '@app/common';
import type { RmqContext } from '@nestjs/microservices';
import { RpcException } from '@nestjs/microservices';
import { QueryFailedError } from 'typeorm';
import { OrderServiceController } from './order-service.controller';

/**
 * BOT-3d (NIMA 12): kuryer amallari (sell/cancel/...) uchun mijoz
 * `Idempotency-Key`'i (gateway → `idem:<user>:<sha256>`) amal + buyurtmaga
 * BOG'LANADI. Ayni kalit boshqa amal yoki buyurtma bilan kelsa → 422, eski
 * natija qaytmaydi.
 */
const stub = <T>(value: unknown): T => value as T;

/** Xotiradagi `idempotency_keys` jadvali — haqiqiy IdempotencyService bilan. */
function memoryRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    insert: jest.fn((row: Record<string, unknown>) => {
      if (rows.has(row.key as string)) {
        const err = new QueryFailedError(
          'insert',
          [],
          new Error('dup') as never,
        );
        (err as QueryFailedError & { code?: string }).code = '23505';
        return Promise.reject(err);
      }
      rows.set(row.key as string, { ...row, created_at: new Date() });
      return Promise.resolve(undefined);
    }),
    findOne: jest.fn(({ where }: { where: { key: string } }) =>
      Promise.resolve(rows.get(where.key) ?? null),
    ),
    update: jest.fn(
      ({ key }: { key: string }, patch: Record<string, unknown>) => {
        rows.set(key, { ...rows.get(key), ...patch });
        return Promise.resolve({ affected: 1 });
      },
    ),
  };
}

function setup() {
  const repo = memoryRepo();
  const idem = new IdempotencyService(stub(repo));
  const rmqService = {
    ack: jest.fn(),
    nack: jest.fn(),
    nackForError: jest.fn(),
  };
  const lifecycle = {
    sellOrder: jest.fn().mockResolvedValue({
      statusCode: 200,
      data: { id: '101', status: 'sold' },
    }),
    cancelOrder: jest.fn().mockResolvedValue({
      statusCode: 200,
      data: { id: '101', status: 'cancelled' },
    }),
  };
  const controller = new OrderServiceController(
    stub(rmqService),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub(lifecycle),
    idem,
    stub({ resolve: jest.fn() }),
  );
  return { controller, lifecycle, repo };
}

const ctx = stub<RmqContext>({});
const KEY = 'idem:25:' + 'b'.repeat(64);
const requester = { id: '25', roles: ['courier'] };

describe('BOT-3d — kuryer amali Idempotency-Key bog‘lanishi', () => {
  it('ayni kalit, ayni amal + buyurtma → bitta bajarilish, keshdagi natija', async () => {
    const { controller, lifecycle } = setup();
    const payload = { id: '101', dto: {}, requester, request_id: KEY };
    const first = await controller.sell(stub(payload), ctx);
    const second = await controller.sell(stub(payload), ctx);
    expect(lifecycle.sellOrder).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('⭐ ayni kalit BOSHQA amal bilan → 422, eski natija qaytmaydi', async () => {
    const { controller, lifecycle } = setup();
    await controller.sell(
      stub({ id: '101', dto: {}, requester, request_id: KEY }),
      ctx,
    );
    const promise = controller.cancel(
      stub({ id: '101', dto: {}, requester, request_id: KEY }),
      ctx,
    );
    await expect(promise).rejects.toBeInstanceOf(RpcException);
    await promise.catch((error: RpcException) =>
      expect(error.getError()).toEqual({
        statusCode: 422,
        message: IDEMPOTENCY_KEY_MISMATCH_MESSAGE,
      }),
    );
    expect(lifecycle.cancelOrder).not.toHaveBeenCalled();
  });

  it('⭐ ayni kalit BOSHQA buyurtma bilan → 422', async () => {
    const { controller, lifecycle } = setup();
    await controller.sell(
      stub({ id: '101', dto: {}, requester, request_id: KEY }),
      ctx,
    );
    await expect(
      controller.sell(
        stub({ id: '102', dto: {}, requester, request_id: KEY }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(lifecycle.sellOrder).toHaveBeenCalledTimes(1);
  });

  it('kalitsiz (UUID request_id) eski yo‘l o‘zgarmaydi — bog‘lanish yozilmaydi', async () => {
    const { controller, repo } = setup();
    await controller.sell(
      stub({
        id: '101',
        dto: {},
        requester,
        request_id: 'c0ffee00-0000-4000-8000-000000000001',
      }),
      ctx,
    );
    const [row] = [...repo.rows.values()];
    expect(row.pattern).toBe('order.sell');
  });
});
