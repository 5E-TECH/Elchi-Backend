import { RpcException } from '@nestjs/microservices';
import { Order_status } from '@app/common';
import { OrderServiceService } from './order-service.service';

/**
 * 0d11ewk7 — order.courier_counts: kuryer tablari sonlari. Har tab gateway
 * ro'yxati yuboradigan AYNI findAll so'rovi bilan (limit 1) sanaladi —
 * `total` = ro'yxat `total`i. Parite gateway tomonda ham tekshiriladi
 * (api-gateway/src/order-gateway.courier-counts.spec.ts).
 */
const build = (totals: { waiting: number; all: number; cancelled: number }) => {
  const service = Object.create(
    OrderServiceService.prototype,
  ) as OrderServiceService;
  const findAll = jest
    .spyOn(service, 'findAll')
    .mockImplementation((query: Record<string, unknown>) => {
      const statuses = (query.status as string[] | undefined) ?? [];
      const total = query.courier_cancelled_tab
        ? totals.cancelled
        : statuses.includes(Order_status.WAITING)
          ? totals.waiting
          : totals.all;
      return Promise.resolve({
        data: [],
        total,
        page: 1,
        limit: 1,
        total_pages: total,
        totalPages: total,
      } as never);
    });
  return { service, findAll };
};

describe('0d11ewk7 — courierOrderCounts', () => {
  it("uchala tab — ro'yxatdagi AYNI so'rovlar, limit 1, javob {waiting, all, cancelled}", async () => {
    const { service, findAll } = build({
      waiting: 12,
      all: 1234,
      cancelled: 3,
    });
    const res = await service.courierOrderCounts({
      courier_id: '119',
      post_ids: ['5', '6', '5', 'x'],
    });
    expect(res).toEqual({ waiting: 12, all: 1234, cancelled: 3 });
    expect(findAll).toHaveBeenCalledTimes(3);
    const queries = findAll.mock.calls.map(([query]) => query);
    expect(queries).toEqual(
      expect.arrayContaining([
        {
          post_ids: ['5', '6'],
          status: [Order_status.WAITING],
          page: 1,
          limit: 1,
        },
        {
          post_ids: ['5', '6'],
          exclude_statuses: [
            Order_status.CREATED,
            Order_status.NEW,
            Order_status.RECEIVED,
            Order_status.ON_THE_ROAD,
          ],
          page: 1,
          limit: 1,
        },
        {
          status: [Order_status.CANCELLED],
          courier_ids: ['119'],
          holder_courier_ids: ['119'],
          courier_scope: 'any',
          courier_post_history: true,
          courier_cancelled_tab: true,
          page: 1,
          limit: 1,
        },
      ]),
    );
  });

  it("pochtasi yo'q kuryer: waiting/all = 0 (so'rovsiz), cancelled baribir sanaladi", async () => {
    const { service, findAll } = build({ waiting: 9, all: 9, cancelled: 2 });
    const res = await service.courierOrderCounts({
      courier_id: '119',
      post_ids: [],
    });
    expect(res).toEqual({ waiting: 0, all: 0, cancelled: 2 });
    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findAll.mock.calls[0][0]).toMatchObject({
      courier_cancelled_tab: true,
    });
  });

  it.each([undefined, '', '0', 'abc'])(
    "noto'g'ri courier_id (%p) → 400, bazaga so'rov yo'q",
    async (courierId) => {
      const { service, findAll } = build({ waiting: 0, all: 0, cancelled: 0 });
      await expect(
        service.courierOrderCounts({ courier_id: courierId, post_ids: ['5'] }),
      ).rejects.toBeInstanceOf(RpcException);
      expect(findAll).not.toHaveBeenCalled();
    },
  );
});
