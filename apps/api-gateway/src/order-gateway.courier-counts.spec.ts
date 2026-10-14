import { GUARDS_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { OrderGatewayController } from './order-gateway.controller';
import { OrderServiceService } from '../../order-service/src/order-service.service';

/**
 * 0d11ewk7 — GET /orders/courier/orders/counts (kuryer tablari badge'i).
 *
 * - faqat COURIER (RolesGuard @Roles bo'lmasa marshrutni HAMMAGA ochadi);
 * - kuryer pochtalari ro'yxat bilan AYNI yo'l (logistics.post.my_for_courier,
 *   barcha sahifalar), doira — JWT `sub`;
 * - PARITE: order-service sanaydigan har tab so'rovi GET
 *   /orders/courier/orders shu tab uchun yuboradigan so'rov bilan AYNAN bir
 *   xil (page/limit dan tashqari) — badge va ro'yxat `total`i farq qilmaydi.
 */
type Row = Record<string, unknown>;

const COURIER = { sub: '119', username: 'k', roles: ['courier'] };

const setup = (counts: unknown = { waiting: 4, all: 1250, cancelled: 2 }) => {
  const order = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'order.courier_counts') return of(counts);
      return of({ data: [], total: 0, page: 1, limit: 10 });
    }),
  };
  // Kuryerning 2 sahifa pochtasi (findAllCourierPostIds barcha sahifani oladi).
  const logistics = {
    send: jest.fn((pattern: { cmd: string }, payload: { page: number }) => {
      if (pattern.cmd !== 'logistics.post.my_for_courier') return of({});
      return of({
        statusCode: 200,
        data: {
          data: payload.page === 1 ? [{ id: '5' }, { id: '6' }] : [{ id: '7' }],
          total: 3,
          totalPages: 2,
        },
      });
    }),
  };
  const controller = new OrderGatewayController(
    order as never,
    { send: jest.fn(() => of({})) } as never,
    logistics as never,
    { send: jest.fn(() => of({ data: { id: '1' } })) } as never,
  );
  const sentTo = (cmd: string) =>
    (order.send.mock.calls as unknown as Array<[{ cmd: string }, Row]>).filter(
      ([pattern]) => pattern.cmd === cmd,
    );
  return { controller, order, logistics, sentTo };
};

describe('0d11ewk7 — GET /orders/courier/orders/counts', () => {
  it('faqat COURIER: JwtAuthGuard + RolesGuard + @Roles(courier)', () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'courierOrderCounts',
    )?.value as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['courier']);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });

  it("statik marshrut: 'courier/orders/counts' ro'yxat marshrutidan oldin e'lon qilingan", () => {
    const names = Object.getOwnPropertyNames(OrderGatewayController.prototype);
    expect(names.indexOf('courierOrderCounts')).toBeGreaterThan(-1);
    expect(names.indexOf('courierOrderCounts')).toBeLessThan(
      names.indexOf('findCourierOrdersLegacy'),
    );
  });

  it('barcha sahifa pochtalari + JWT sub order.courier_counts ga, javob {waiting, all, cancelled}', async () => {
    const { controller, sentTo } = setup();
    const res = await controller.courierOrderCounts({ user: COURIER });
    expect(res).toEqual({
      statusCode: 200,
      message: 'Courier order counts',
      data: { waiting: 4, all: 1250, cancelled: 2 },
    });
    const calls = sentTo('order.courier_counts');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({
      courier_id: '119',
      post_ids: ['5', '6', '7'],
    });
  });

  it("noto'g'ri/bo'sh javob → 0 (badge yashirinadi, NaN chiqmaydi)", async () => {
    const { controller } = setup({ waiting: 'x', all: -3 });
    const res = await controller.courierOrderCounts({ user: COURIER });
    expect(res.data).toEqual({ waiting: 0, all: 0, cancelled: 0 });
  });

  it("PARITE: har tab sanash so'rovi = ro'yxat so'rovi (page/limit dan tashqari)", async () => {
    const { controller, sentTo } = setup();
    // Ro'yxat (frontend tablari): pending → status=waiting, all → statussiz,
    // cancelled → status=cancelled.
    for (const status of ['waiting', undefined, 'cancelled']) {
      await controller.findCourierOrdersLegacy(
        status,
        undefined,
        undefined,
        undefined,
        '1',
        '10',
        { user: COURIER } as never,
      );
    }
    const strip = (query: Row) =>
      Object.fromEntries(
        Object.entries(query).filter(
          ([key, value]) =>
            value !== undefined && key !== 'page' && key !== 'limit',
        ),
      );
    const listQueries = sentTo('order.find_all_enriched').map(([, payload]) =>
      strip(payload.query as Row),
    );
    expect(listQueries).toHaveLength(3);

    // order-service'ning haqiqiy courierOrderCounts'i qaysi so'rovlarni sanaydi.
    const service = Object.create(
      OrderServiceService.prototype,
    ) as OrderServiceService;
    const findAll = jest
      .spyOn(service, 'findAll')
      .mockResolvedValue({ data: [], total: 0 } as never);
    await service.courierOrderCounts({
      courier_id: '119',
      post_ids: ['5', '6', '7'],
    });
    const countQueries = findAll.mock.calls.map(([query]) =>
      strip(query as Row),
    );

    expect(countQueries).toHaveLength(3);
    for (const listQuery of listQueries) {
      expect(countQueries).toContainEqual(listQuery);
    }
    // Ishonch uchun: uchala tab ham haqiqatan turli so'rov.
    expect(listQueries[0]).toMatchObject({ status: [Order_status.WAITING] });
    expect(listQueries[2]).toMatchObject({ courier_cancelled_tab: true });
  });
});
