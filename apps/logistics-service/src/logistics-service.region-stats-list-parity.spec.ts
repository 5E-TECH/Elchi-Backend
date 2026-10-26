import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';
import { OrderGatewayController } from '../../api-gateway/src/order-gateway.controller';

/**
 * aLx7Di99 — PARITE: GET /region/my/district-stats raqamlari sanaladigan
 * `order.find_all` so'rovi so'rovchining /orders «Barchasi» ro'yxati
 * yuboradigan so'rov bilan AYNAN bir xil (sahifalashdan tashqari) — /regions
 * jami va /orders jami farq qilmaydi (prod 2026-10-27: kuryer 26 → 39 vs 44).
 *  - kuryer: gateway GET /orders/courier/orders (holatsiz) ↔ logistics;
 *    pochtalar ham bitta ta'rif (`myPostsForCourier` ↔ `findCourierPostIds`);
 *  - menejer: gateway GET /orders doirasi (`resolveOrderListRequest`) ↔
 *    logistics.
 */
type Row = Record<string, unknown>;

const COURIER_ID = '77';
const POST_IDS = ['p77a', 'p77b'];
const START = '2026-10-01';
const END = '2026-10-26';

const strip = (query: Row) =>
  Object.fromEntries(
    Object.entries(query).filter(
      ([key, value]) =>
        value !== undefined && !['page', 'limit', 'fetch_all'].includes(key),
    ),
  );

function logisticsSetup(opts: {
  courierRegion?: string;
  branch?: { branch_id: string; region_id: string };
}) {
  const postRepo = {
    find: jest.fn(() => Promise.resolve(POST_IDS.map((id) => ({ id })))),
    findAndCount: jest.fn(() =>
      Promise.resolve([POST_IDS.map((id) => ({ id })), POST_IDS.length]),
    ),
  };
  const regionRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id,
        name: `Viloyat-${where.id}`,
        sato_code: '1703',
        districts: [{ id: `${where.id}01`, name: 'Tuman', sato_code: 'A' }],
      }),
    ),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: { ids?: string[] }) => {
      if (pattern.cmd === 'identity.courier.find_by_ids') {
        return of({
          data: [
            {
              id: String(payload.ids?.[0]),
              role: 'courier',
              region_id: opts.courierRegion ?? null,
            },
          ],
        });
      }
      return of({ data: { items: [] } });
    }),
  };
  const branchClient = {
    send: jest.fn(() =>
      of({
        data: opts.branch
          ? {
              branch_id: opts.branch.branch_id,
              branch: {
                type: 'REGIONAL',
                region_id: opts.branch.region_id,
                name: 'QA Filial',
              },
            }
          : null,
      }),
    ),
  };
  const service = new LogisticsServiceService(
    postRepo as never,
    regionRepo as never,
    {} as never,
    { send: jest.fn(() => of({})) } as never,
    branchClient as never,
    identityClient as never,
    { send: jest.fn(() => of({})) } as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
  );
  const findOrders = jest
    .spyOn(service as never, 'findOrders')
    .mockResolvedValue([] as never);
  return { service, findOrders, postRepo };
}

function gatewaySetup() {
  const order = {
    send: jest.fn(() => of({ data: [], total: 0, page: 1, limit: 10 })),
  };
  const logistics = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd !== 'logistics.post.my_for_courier') return of({});
      return of({
        statusCode: 200,
        data: {
          data: POST_IDS.map((id) => ({ id })),
          total: POST_IDS.length,
          totalPages: 1,
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
  const listQueries = () =>
    (order.send.mock.calls as unknown as Array<[{ cmd: string }, Row]>)
      .filter(([pattern]) => pattern.cmd === 'order.find_all_enriched')
      .map(([, payload]) => strip(payload.query as Row));
  return { controller, listQueries };
}

describe('aLx7Di99 — /regions raqamlari = /orders «Barchasi» so‘rovi', () => {
  it('⭐ kuryer: district-stats so‘rovi = GET /orders/courier/orders (holatsiz) so‘rovi', async () => {
    const gateway = gatewaySetup();
    await gateway.controller.findCourierOrdersLegacy(
      undefined,
      undefined,
      START,
      END,
      '1',
      '10',
      { user: { sub: COURIER_ID, roles: ['courier'] } } as never,
    );
    const [listQuery] = gateway.listQueries();
    expect(listQuery).toEqual(expect.objectContaining({ post_ids: POST_IDS }));

    const logistics = logisticsSetup({ courierRegion: '3' });
    await logistics.service.getMyRegionDistrictStats(START, END, {
      id: COURIER_ID,
      roles: ['courier'],
    });
    expect(logistics.findOrders).toHaveBeenCalledTimes(1);
    const statsQuery = strip(
      (logistics.findOrders.mock.calls[0] as unknown as [Row])[0],
    );
    expect(statsQuery).toEqual(listQuery);
  });

  it('kuryer pochtalari — bitta ta‘rif: myPostsForCourier (gateway post_ids manbai) = findCourierPostIds', async () => {
    const { service, postRepo } = logisticsSetup({ courierRegion: '3' });
    await service.myPostsForCourier(1, 100, {
      id: COURIER_ID,
      roles: ['courier'],
    });
    await service.getMyRegionDistrictStats(undefined, undefined, {
      id: COURIER_ID,
      roles: ['courier'],
    });
    const listWhere = (
      postRepo.findAndCount.mock.calls[0] as unknown as [{ where: unknown }]
    )[0].where;
    const statsWhere = (
      postRepo.find.mock.calls[0] as unknown as [{ where: unknown }]
    )[0].where;
    expect(statsWhere).toEqual(listWhere);
    expect(statsWhere).toEqual({ courier_id: COURIER_ID });
  });

  it('⭐ menejer: district-stats so‘rovi = GET /orders (holatsiz) doirasi', async () => {
    const gateway = gatewaySetup();
    const request = await (
      gateway.controller as unknown as {
        resolveOrderListRequest: (
          filters: Row,
          user: unknown,
          page?: string,
          limit?: string,
        ) => Promise<{ kind: string; query: Row }>;
      }
    ).resolveOrderListRequest(
      { start_day: START, end_day: END },
      { sub: '25', roles: ['manager'], branch_id: '3' },
      '1',
      '10',
    );
    expect(request.kind).toBe('query');
    const listQuery = strip(request.query);
    expect(listQuery).toEqual({
      branch_id: '3',
      start_day: START,
      end_day: END,
    });

    const logistics = logisticsSetup({
      branch: { branch_id: '3', region_id: '3' },
    });
    await logistics.service.getMyRegionDistrictStats(START, END, {
      id: '25',
      roles: ['manager'],
      branch_id: '3',
    });
    const statsQuery = strip(
      (logistics.findOrders.mock.calls[0] as unknown as [Row])[0],
    );
    expect(statsQuery).toEqual(listQuery);
  });
});
