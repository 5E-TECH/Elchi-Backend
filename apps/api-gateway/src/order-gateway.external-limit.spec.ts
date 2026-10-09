import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import {
  EXTERNAL_ALLOWED_LIMITS,
  OrderGatewayController,
} from './order-gateway.controller';

/**
 * PEc4BjVX — kiruvchi posilkalar skan ekrani `GET /orders/external?limit=200`
 * yuboradi; ilgari gateway 400 ("limit faqat 10, 25, 50, 100") qaytarib, ekran
 * "KELGAN 0" bo'lib qolardi. Umumiy ro'yxatlar chegarasi o'zgarmagan.
 */
describe('limit ruxsat ro`yxatlari (PEc4BjVX)', () => {
  const make = () => {
    const orderClient = {
      send: jest.fn(() => of({ data: [], total: 0, page: 1, limit: 200 })),
    };
    const noop = { send: jest.fn(() => of({ data: null })) };
    const controller = new OrderGatewayController(
      orderClient as any,
      noop as any,
      noop as any,
      noop as any,
    );
    return { controller, orderClient };
  };
  const admin = {
    user: { sub: '1', username: 'sa', roles: ['superadmin'] },
  } as any;

  const external = (controller: OrderGatewayController, limit: string) =>
    controller.findAllExternal(
      '121',
      'new',
      undefined,
      undefined,
      undefined,
      '1',
      limit,
      undefined,
      admin,
    );

  it('⭐ TC1: GET /orders/external?limit=200 — 400 emas, order-service ga 200 ketadi', async () => {
    const { controller, orderClient } = make();
    await external(controller, '200');
    const call = orderClient.send.mock.calls.find(
      (c: any[]) => c[0]?.cmd === 'order.external.find_all',
    ) as any[];
    expect(call).toBeDefined();
    expect(call[1].query.limit).toBe(200);
  });

  it('GET /orders/external?limit=500 — hamon 400', async () => {
    const { controller } = make();
    await expect(external(controller, '500')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('⭐ TC5: skan ekrani 200 tagacha so`ray oladi (ruxsat ro`yxatida)', () => {
    // Frontend hozir limit=100 + sahifalash ishlatadi; 200 — karta so'ragan
    // yuqori chegara (bitta so'rovda 101+ posilka "topilmadi" bo'lmasin).
    const FRONTEND_INCOMING_LIMIT = 200;
    expect(EXTERNAL_ALLOWED_LIMITS).toContain(FRONTEND_INCOMING_LIMIT);
  });

  it('regressiya: oddiy GET /orders?limit=200 hamon 400', async () => {
    const { controller } = make();
    await expect(
      controller.findAll(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '200',
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
