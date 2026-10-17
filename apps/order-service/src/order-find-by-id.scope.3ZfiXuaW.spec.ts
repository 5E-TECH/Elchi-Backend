import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { OrderServiceController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';

/**
 * 3ZfiXuaW #3 / 5i3UZjiF #4 — `order.find_by_id` ga `requester` berilsa doira
 * order-service'da qo'yiladi: begona buyurtma — xuddi yo'q buyurtmadek 404
 * (mavjudligi oshkor bo'lmaydi). Requester'siz (ichki chaqiruvchilar) —
 * o'zgarmagan.
 */
describe('3ZfiXuaW — order.find_by_id requester doirasi', () => {
  const order = {
    id: '1251145',
    market_id: '37',
    courier_id: '25',
    holder_courier_id: null,
  };
  const make = (row: unknown) => {
    const svc = Object.create(
      OrderServiceService.prototype,
    ) as OrderServiceService;
    Object.assign(svc, {
      orderRepo: { findOne: jest.fn().mockResolvedValue(row) },
    });
    return svc;
  };
  const statusOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (error: unknown) =>
        ((error as RpcException).getError() as { statusCode: number })
          .statusCode,
    );

  it('⭐ begona kuryer / begona market — 404 (yo‘q buyurtma bilan bir xil)', async () => {
    expect(
      await statusOf(
        make(order).findById('1251145', { id: '26', roles: ['courier'] }),
      ),
    ).toBe(404);
    expect(
      await statusOf(
        make(order).findById('1251145', { id: '38', roles: ['market'] }),
      ),
    ).toBe(404);
    expect(
      await statusOf(
        make(null).findById('1251145', { id: '37', roles: ['market'] }),
      ),
    ).toBe(404);
  });

  it('o‘z buyurtmasi va requester’siz ichki chaqiruv — qaytadi', async () => {
    await expect(
      make(order).findById('1251145', { id: '25', roles: ['courier'] }),
    ).resolves.toBe(order);
    await expect(make(order).findById('1251145')).resolves.toBe(order);
  });

  it('controller requester’ni servisga uzatadi', async () => {
    const findById = jest.fn().mockResolvedValue(order);
    const controller = Object.create(
      OrderServiceController.prototype,
    ) as OrderServiceController;
    Object.assign(controller, {
      orderService: { findById },
      executeAndAck: (_ctx: unknown, fn: () => unknown) => fn(),
    });
    const handler = Object.getOwnPropertyDescriptor(
      OrderServiceController.prototype,
      'findById',
    )!.value as (data: unknown, ctx: unknown) => Promise<unknown>;
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.find_by_id' },
    ]);
    await handler.call(
      controller,
      { id: '1', requester: { id: '25', roles: ['courier'] } },
      {},
    );
    expect(findById).toHaveBeenCalledWith('1', {
      id: '25',
      roles: ['courier'],
    });
  });
});
