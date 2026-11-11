import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * Carrier API ultracode review — kechikkan / takroriy bitta buyurtma qabuli
 * (`receiveOrderWithScannerCourier`, `logistics.post.receive_order`)
 * sotilgan buyurtmani `waiting` ga QAYTARMAYDI (pul daftari ajralib qolardi),
 * allaqachon `waiting` ni qayta yozmaydi. Holat himoyasi (2026-11-07) bilan:
 * faqat yo'ldagi buyurtma qabul qilinadi, qolgani 400 `order_not_receivable`
 * (Carrier gateway parallel skanda buni oddiy takror deb qayta o'qiydi).
 */
describe('receiveOrderWithScannerCourier — yakuniy holatni qayta yozmaydi', () => {
  function setup(order: Record<string, unknown>) {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') return of(order);
        if (pattern.cmd === 'order.find_all') return of({ data: { data: [] } });
        return of({ statusCode: 200 });
      }),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '40',
        courier_id: '179',
        status: Post_status.SENT,
      }),
      save: jest.fn((entity: Record<string, unknown>) =>
        Promise.resolve({ ...entity }),
      ),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      { send: jest.fn(() => of({})) } as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const updates = () =>
      orderClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'order.update',
      );
    return { service, updates, postRepo };
  }

  const courier = { id: '179', roles: ['courier'] };
  const base = { id: '900', post_id: '40' };

  it('on the road -> WAITING yoziladi (avvalgidek)', async () => {
    const ctx = setup({ ...base, status: Order_status.ON_THE_ROAD });
    await ctx.service.receiveOrderWithScannerCourier(courier, '900');
    expect(ctx.updates()).toHaveLength(1);
    expect(ctx.updates()[0][1]).toMatchObject({
      id: '900',
      dto: { status: Order_status.WAITING, return_requested: false },
    });
  });

  it('allaqachon waiting -> 400 order_not_receivable, yozuv yo‘q, pochta tegilmaydi', async () => {
    const ctx = setup({ ...base, status: Order_status.WAITING });
    const result = ctx.service.receiveOrderWithScannerCourier(courier, '900');
    await expect(result).rejects.toBeInstanceOf(RpcException);
    await result.catch((e: RpcException) =>
      expect(e.getError()).toMatchObject({
        statusCode: 400,
        data: { reason: 'order_not_receivable' },
      }),
    );
    expect(ctx.updates()).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('⭐ sotilgan / bekor / qaytarilgan -> 400, holat o‘zgarmaydi', async () => {
    for (const status of [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.RETURNED_TO_MARKET,
      Order_status.CLOSED,
    ]) {
      const ctx = setup({ ...base, status });
      const result = ctx.service.receiveOrderWithScannerCourier(courier, '900');
      await expect(result).rejects.toBeInstanceOf(RpcException);
      await result.catch((e: RpcException) =>
        expect(e.getError()).toMatchObject({ statusCode: 400 }),
      );
      expect(ctx.updates()).toHaveLength(0);
    }
  });
});
