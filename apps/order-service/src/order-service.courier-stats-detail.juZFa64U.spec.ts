/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { OrderServiceController } from './order-service.controller';
import { OrderAnalyticsService } from './analytics/order-analytics.service';

/**
 * juZFa64U — `order.analytics.courier_stats {include_detail: true}`:
 *   - controller bayroqni servisga uzatadi (faqat aynan `true`);
 *   - servis har qatorga `canceledOrders` / `profit` ni BITTA
 *     `getCourierReportDetails` chaqiruvi bilan qo'shadi (kuryerlar soniga
 *     bog'liq emas); bayroqsiz — eski shakl, qo'shimcha so'rov yo'q.
 * Raqamlarning eski yo'l bilan tengligi — courier-report-batch.juZFa64U.pg.spec.ts.
 */
describe('juZFa64U — courier_stats include_detail', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'analyticsCourierStats',
  )?.value as (...args: unknown[]) => Promise<unknown>;

  it("naqsh o'zgarmagan: { cmd: 'order.analytics.courier_stats' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.analytics.courier_stats' },
    ]);
  });

  it.each([
    [{ include_detail: true }, true],
    [{ include_detail: 'true' }, false],
    [{}, false],
  ])('payload %j → includeDetail %p', async (extra, expected) => {
    const orderAnalyticsService = {
      getCourierStats: jest.fn().mockResolvedValue([]),
    };
    const executeAndAck = jest.fn((_ctx: unknown, fn: () => unknown) => fn());

    await handler.call(
      { executeAndAck, orderAnalyticsService },
      { startDate: '2026-06-01', endDate: '2026-06-30', ...extra },
      {},
    );

    expect(orderAnalyticsService.getCourierStats).toHaveBeenCalledWith(
      '2026-06-01',
      '2026-06-30',
      undefined,
      undefined,
      expected,
    );
  });

  function makeService(couriers: number) {
    const service = Object.create(
      OrderAnalyticsService.prototype,
    ) as OrderAnalyticsService & Record<string, any>;
    const rows = Array.from({ length: couriers }, (_, i) => ({
      post_id: String(100 + i),
      total: '4',
      sold: '2',
    }));
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'where',
      'andWhere',
      'select',
      'addSelect',
      'setParameters',
      'groupBy',
    ]) {
      qb[method] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    const details = jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { canceledOrders: 1, profit: 60000 }])),
      ),
    );
    Object.assign(service, {
      orderRepo: { createQueryBuilder: jest.fn(() => qb) },
      logger: { warn: jest.fn() },
      getPostsByIds: jest.fn((ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id, courier_id: `9${id}` }))),
      ),
      lookup: {
        getCouriersByIds: jest.fn((ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, name: `K-${id}` }))),
        ),
      },
      getCourierReportDetails: details,
    });
    return { service, details };
  }

  it.each([1, 8, 50])(
    '⭐ %i kuryer — getCourierReportDetails BIR marta, har qatorda canceledOrders/profit',
    async (n) => {
      const { service, details } = makeService(n);

      const res: any[] = await service.getCourierStats(
        '2026-06-01',
        '2026-06-30',
        undefined,
        false,
        true,
      );

      expect(res).toHaveLength(n);
      expect(details).toHaveBeenCalledTimes(1);
      expect(details.mock.calls[0][0]).toHaveLength(n);
      for (const row of res) {
        expect(row).toMatchObject({
          totalOrders: 4,
          soldOrders: 2,
          successRate: 50,
          canceledOrders: 1,
          profit: 60000,
        });
      }
    },
  );

  it('bayroqsiz — eski shakl, getCourierReportDetails chaqirilmaydi', async () => {
    const { service, details } = makeService(3);

    const res: any[] = await service.getCourierStats(
      '2026-06-01',
      '2026-06-30',
    );

    expect(details).not.toHaveBeenCalled();
    expect(Object.keys(res[0]).sort()).toEqual(
      ['courier', 'soldOrders', 'successRate', 'totalOrders'].sort(),
    );
  });
});
