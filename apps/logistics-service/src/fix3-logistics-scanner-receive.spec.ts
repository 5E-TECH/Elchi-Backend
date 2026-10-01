import { RpcException } from '@nestjs/microservices';
import { TimeoutError, of, throwError } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * FIX3 CODE-09 / C13 — kuryer skan bilan qabul qilganda qaytarish so'rovi
 * belgisi (return_requested) tozalanadi.
 * FIX3 CODE-13 / C12 — P1b receive_one_by_scan xatosi RpcException bo'lib,
 * o'z holat kodi bilan qaytadi (500 emas, qayta navbat yo'q).
 */
describe('FIX3 CODE-09 — skan bilan qabul return_requested ni tozalaydi', () => {
  function setup(options: { orders: Array<Record<string, unknown>> }) {
    const orderClient = {
      send: jest.fn(
        (pattern: { cmd: string }, payload: { query?: { limit?: number } }) => {
          if (pattern.cmd === 'order.find_all') {
            // receiveOrderWithScannerCourier qolganini limit 1 bilan so'raydi.
            return of({
              data: { data: payload.query?.limit === 1 ? [] : options.orders },
            });
          }
          if (pattern.cmd === 'order.find_by_id') {
            return of(options.orders[0]);
          }
          return of({ statusCode: 200 });
        },
      ),
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
      orderClient.send.mock.calls
        .filter(([pattern]) => pattern.cmd === 'order.update')
        .map(([, payload]) => payload as { id: string; dto: unknown });
    return { service, updates };
  }

  const flaggedOnTheRoad = (id: string) => ({
    id,
    status: Order_status.ON_THE_ROAD,
    return_requested: true,
    post_id: '40',
  });

  it('PATCH post/receive/scan/:id — har bir buyurtma WAITING + return_requested:false', async () => {
    const ctx = setup({
      orders: [flaggedOnTheRoad('101'), flaggedOnTheRoad('102')],
    });

    await ctx.service.receivePostWithScanner(
      { id: '179', roles: ['courier'] },
      'POST-token',
    );

    expect(ctx.updates()).toEqual([
      {
        id: '101',
        dto: { status: Order_status.WAITING, return_requested: false },
      },
      {
        id: '102',
        dto: { status: Order_status.WAITING, return_requested: false },
      },
    ]);
  });

  it('PATCH post/receive/order/:id — WAITING + return_requested:false', async () => {
    const ctx = setup({ orders: [flaggedOnTheRoad('101')] });

    await ctx.service.receiveOrderWithScannerCourier(
      { id: '179', roles: ['courier'] },
      '101',
    );

    expect(ctx.updates()).toEqual([
      {
        id: '101',
        dto: { status: Order_status.WAITING, return_requested: false },
      },
    ]);
  });
});

describe('FIX3 CODE-13 — P1b receive_one_by_scan xatosi holat kodi bilan qaytadi', () => {
  function setup(receiveError: unknown) {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_qr') {
          return of({
            data: {
              id: '101',
              branch_id: '99',
              status: Order_status.ON_THE_ROAD,
              courier_id: null,
              post_id: null,
            },
          });
        }
        if (pattern.cmd === 'order.transfer_batch.receive_one_by_scan') {
          return throwError(() => receiveError);
        }
        return of({ statusCode: 200 });
      }),
    };
    const branchClient = {
      send: jest.fn(() =>
        of({
          data: { branch_id: '10', branch: { id: '10', type: 'REGIONAL' } },
        }),
      ),
    };
    const service = new LogisticsServiceService(
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { service, orderClient };
  }

  async function expectRpc(
    promise: Promise<unknown>,
    statusCode: number,
    message?: string,
  ) {
    try {
      await promise;
      throw new Error('Expected RpcException');
    } catch (error) {
      // Xom obyekt EMAS — executeAndAck uni qayta navbatga qo'ymasin.
      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
      expect(payload.statusCode).toBe(statusCode);
      if (message) {
        expect(payload.message).toBe(message);
      }
    }
  }

  const scan = (service: LogisticsServiceService) =>
    service.scanAssignOrder(
      { id: '179', roles: ['courier'] },
      { qr_token: 'ORD-abc' },
    );

  it('transportdan kelgan xom {statusCode:400} — RpcException 400, matn saqlanadi', async () => {
    const message =
      "Paket hali jo'natilmagan — posilka filialga yetib kelmagan";
    const ctx = setup({ statusCode: 400, message });

    await expectRpc(scan(ctx.service), 400, message);
    expect(
      ctx.orderClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'order.update',
      ),
    ).toHaveLength(0);
  });

  it('xom {statusCode:404} — RpcException 404', async () => {
    const ctx = setup({ statusCode: 404, message: 'Order not found' });

    await expectRpc(scan(ctx.service), 404, 'Order not found');
  });

  it('timeout — RpcException 502 (o‘zbekcha matn)', async () => {
    const ctx = setup(new TimeoutError());

    await expectRpc(
      scan(ctx.service),
      502,
      "Buyurtmani skan orqali filialga qabul qilib bo'lmadi — birozdan so'ng qayta urinib ko'ring",
    );
  });
});
