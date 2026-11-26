import { readFileSync } from 'fs';
import { join } from 'path';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { BranchGatewayController } from './branch-gateway.controller';
import { ExcelGatewayController } from './excel-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import {
  BRANCH_STAFF_HIDDEN_ORDER_FIELDS,
  COURIER_HIDDEN_MARKET_PROFILE_FIELDS,
  projectOrderSettlementForRoles,
} from './auth/order-role-projection';
import { buildOrdersAccountsXlsx } from './order-export/orders-accounts-xlsx';

/**
 * D5NxxpJW (P0, ega 2026-11-20 / 2026-11-25) — menejer (va filial hisobi,
 * registrator) buyurtmaning market tarifini HECH BIR javobdan bilolmaydi.
 * GET /orders va GET /orders/:id — order-gateway.role-projection.spec.ts;
 * bu yerda avval proyeksiyaSIZ qaytgan yo'llar.
 */
jest.mock('./order-export/orders-accounts-xlsx', () => ({
  ...jest.requireActual<object>('./order-export/orders-accounts-xlsx'),
  buildOrdersAccountsXlsx: jest.fn(() => Promise.resolve(Buffer.from('PK'))),
}));

type Row = Record<string, any>;

const marketProfile = (): Row => ({
  id: '37',
  name: 'TEST Market',
  role: 'market',
  tariff_home: 30000,
  tariff_center: 20000,
  commission_type: 'percent',
  commission_value: 5,
});

const order = (): Row => ({
  id: '81',
  market_id: '37',
  status: 'sold',
  branch_id: '3',
  home_branch_id: '3',
  holder_branch_id: '3',
  holder_type: 'BRANCH',
  total_price: 100000,
  market_tariff: 20000,
  quoted_market_tariff: 20000,
  to_be_paid: 80000,
  paid_amount: 5000,
  sale_market_paid_amount: 5000,
  sale_market_paid_max: 75000,
  branch_share: 7000,
  courier_tariff: 15000,
  courier_share: 15000,
  market: marketProfile(),
  customer: { id: '29', name: 'Mijoz', phone_number: '+998935556677' },
});

const expectNoTariff = (row: Row) => {
  for (const key of BRANCH_STAFF_HIDDEN_ORDER_FIELDS) {
    expect(row).not.toHaveProperty(key);
  }
  for (const key of COURIER_HIDDEN_MARKET_PROFILE_FIELDS) {
    expect(row.market ?? {}).not.toHaveProperty(key);
  }
};

const expectOrderView = (row: Row) => {
  expectNoTariff(row);
  expect(row).toMatchObject({
    total_price: 100000,
    branch_share: 7000,
    courier_tariff: 15000,
    courier_share: 15000,
  });
};

const user = (roles: string[], sub = '5') =>
  ({ user: { sub, username: 'u', roles, branch_id: '3' } }) as never;

const unwrap = (value: unknown): Promise<any> =>
  isObservable(value) ? firstValueFrom(value) : Promise.resolve(value);

function orderGateway(replies: Record<string, unknown>, role = 'MANAGER') {
  const reply = ({ cmd }: { cmd: string }) =>
    of(replies[cmd] ?? { data: null });
  return new OrderGatewayController(
    { send: jest.fn(reply) } as never,
    {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'identity.market.find_by_ids'
          ? of({ data: [marketProfile()] })
          : reply(pattern),
      ),
    } as never,
    { send: jest.fn(() => of({ data: null })) } as never,
    {
      send: jest.fn(({ cmd }: { cmd: string }) =>
        cmd === 'branch.user.find_by_user'
          ? of({
              data: {
                branch_id: '3',
                role,
                branch: { id: '3', type: 'REGIONAL' },
              },
            })
          : cmd === 'branch.find_hq'
            ? of({ statusCode: 200, data: { id: '1' } })
            : of({ data: [] }),
      ),
    } as never,
  );
}

const full = () => ({ statusCode: 200, data: order() });

describe('D5NxxpJW — order-gateway: ilgari proyeksiyasiz qaytgan javoblar', () => {
  it.each([['manager'], ['branch'], ['registrator']])(
    '⭐ %s GET /orders/branch/cancelled',
    async (role) => {
      const controller = orderGateway(
        {
          'order.find_all_enriched': {
            statusCode: 200,
            data: [order()],
            total: 1,
          },
        },
        role.toUpperCase(),
      );
      const res: any = await controller.findBranchCancelledOrders(
        undefined,
        '1',
        '10',
        user([role]),
      );
      const rows: Row[] = Array.isArray(res.data) ? res.data : res.data.data;
      expect(rows).toHaveLength(1);
      expectOrderView(rows[0]);
    },
  );

  it.each([['manager'], ['registrator']])(
    '⭐ %s GET /orders/markets/new va /cancelled — market profili tarifsiz',
    async (role) => {
      const rows = [{ market_id: '37', count: 2, market: marketProfile() }];
      const controller = orderGateway(
        {
          'order.find_new_markets': rows,
          'order.find_new_markets_enriched': rows,
          'order.find_cancelled_markets_enriched': rows,
        },
        role.toUpperCase(),
      );
      for (const res of [
        await controller.findNewMarkets(user([role])),
        await controller.findCancelledMarkets(user([role])),
      ] as any[]) {
        const list: Row[] = Array.isArray(res) ? res : res.data;
        expect(list[0].market.name).toBe('TEST Market');
        expectNoTariff(list[0]);
      }
    },
  );

  it('⭐ menejer GET /orders/external/sources', async () => {
    const controller = orderGateway({
      'order.find_external_sources': [
        { market_id: '37', count: 2, market: marketProfile() },
      ],
    });
    const res: any = await controller.findExternalSources(user(['manager']));
    expect(res[0].market.name).toBe('TEST Market');
    expectNoTariff(res[0]);
  });

  it('⭐ menejer PATCH /orders/:id; superadmin — o`zgarmagan', async () => {
    const replies = {
      'order.find_by_id': full(),
      'order.update_from_api': full(),
    };
    const asManager: any = await orderGateway(replies).update(
      '81',
      { comment: 'x' },
      user(['manager']),
    );
    expectOrderView(asManager.data);
    const asAdmin: any = await orderGateway(replies).update(
      '81',
      { comment: 'x' },
      user(['superadmin'], '1'),
    );
    expect(asAdmin.data).toEqual(order());
  });

  it('⭐ menejer POST /orders/:id/mark-returned-to-market', async () => {
    const controller = orderGateway({
      'order.find_by_id': full(),
      'order.mark_returned_to_market': full(),
    });
    const res: any = await controller.markReturnedToMarket(
      '81',
      {},
      user(['manager']),
    );
    expectOrderView(res.data);
  });

  it('⭐ registrator POST /orders/:id/initiate-return', async () => {
    const controller = orderGateway(
      { 'order.initiate_return': full() },
      'REGISTRATOR',
    );
    const res: any = await controller.initiateReturn(
      '81',
      {} as never,
      user(['registrator']),
    );
    expectOrderView(res.data);
  });

  it('⭐ menejer POST /orders/sell/:id — javobda to_be_paid/paid_amount yo`q, status bor; kuryerda bor', async () => {
    const sold = {
      statusCode: 200,
      data: {
        id: '81',
        status: 'sold',
        to_be_paid: 80000,
        paid_amount: 5000,
        sale_market_paid_amount: 5000,
      },
    };
    const sell = (role: string) =>
      orderGateway({
        'order.find_by_id': full(),
        'order.sell': sold,
      }).sellOrder('81', {}, undefined, {
        ...(user([role]) as object),
        headers: {},
      } as never) as Promise<any>;
    expect((await sell('manager')).data).toEqual({ id: '81', status: 'sold' });
    expect((await sell('courier')).data).toEqual(sold.data);
  });

  it('⭐ GET /orders/:id/settlement — marketga tegadigan summa faqat superadmin/admin', async () => {
    const settlement = {
      statusCode: 200,
      data: {
        order_id: '81',
        courier_amount: 85000,
        branch_amount: 78000,
        market_amount: 75000,
        market_paid_by_branch_amount: 1000,
        market_paid_by_branch_at: null,
        extra_rows: [{ kind: 'extra_cost', market_amount: -2000 }],
      },
    };
    const controller = orderGateway({
      'order.find_by_id': full(),
      'order.settlement.find_by_order': settlement,
    });
    const asManager: any = await controller.getOrderSettlement(
      '81',
      user(['manager']),
    );
    expect(JSON.stringify(asManager)).not.toMatch(
      /market_amount|market_paid_by_branch_amount/,
    );
    expect(asManager.data).toMatchObject({
      courier_amount: 85000,
      branch_amount: 78000,
    });
    expect(
      await controller.getOrderSettlement('81', user(['admin'], '1')),
    ).toEqual(settlement);
    for (const roles of [['registrator'], ['branch'], [], undefined]) {
      expect(
        JSON.stringify(projectOrderSettlementForRoles(roles, settlement)),
      ).not.toMatch(/market_amount/);
    }
  });
});

describe('D5NxxpJW — paket, pochta va Excel', () => {
  it.each([['manager'], ['branch'], ['registrator']])(
    '⭐ %s GET /transfer-batches/:id va /remaining — items[].order',
    async (role) => {
      const controller = new BranchGatewayController({
        send: jest.fn(() =>
          of({
            statusCode: 200,
            data: { id: '501', items: [{ id: '9001', order: order() }] },
          }),
        ),
      } as never);
      for (const res of [
        await unwrap(controller.findTransferBatchById('501', user([role]))),
        await unwrap(
          controller.findRemainingTransferBatchById('501', user([role])),
        ),
      ]) {
        expectOrderView(res.data.items[0].order);
      }
    },
  );

  it.each([['manager'], ['registrator']])(
    '⭐ %s GET /post/return-requests/list — guruh buyurtmalari',
    async (role) => {
      const controller = new LogisticsGatewayController(
        {
          send: jest.fn(() =>
            of({
              statusCode: 200,
              data: {
                groups: [{ courier: { id: '26' }, orders: [order()] }],
              },
            }),
          ),
        } as never,
        {
          send: jest.fn(({ cmd }: { cmd: string }) =>
            of({
              data:
                cmd === 'identity.market.find_by_id' ? marketProfile() : null,
            }),
          ),
        } as never,
      );
      const res: any = await controller.getReturnRequests(user([role]));
      expectOrderView(res.data.groups[0].orders[0]);
    },
  );

  it.each([
    ['manager', false],
    ['registrator', false],
    ['branch', false],
    ['admin', true],
    ['superadmin', true],
  ])(
    '⭐ %s GET /export/orders.xlsx — market hisobi: %s',
    async (role, marketMoney) => {
      const build = jest.mocked(buildOrdersAccountsXlsx);
      build.mockClear();
      const controller = new ExcelGatewayController(
        { send: jest.fn(() => of({ data: [order()], total: 1 })) } as never,
        { send: jest.fn() } as never,
        {
          send: jest.fn(() => of({ data: { branch_id: '3', role } })),
        } as never,
      );
      await controller.exportOrders(
        { set: jest.fn(), end: jest.fn() } as never,
        ...([undefined, undefined, undefined, undefined, undefined] as const),
        undefined,
        undefined,
        user([role]),
      );
      expect(build.mock.calls[0][0].marketMoney).toBe(marketMoney);
    },
  );

  it('⭐ qo`riqchi: buyurtma qaytaruvchi controller`lar faqat rol proyeksiyasidan o`tadi (aloqa proyeksiyasi yolg`iz — pul sizadi)', () => {
    for (const file of [
      'order-gateway.controller.ts',
      'branch-gateway.controller.ts',
      'logistics-gateway.controller.ts',
    ]) {
      expect(readFileSync(join(__dirname, file), 'utf8')).not.toMatch(
        /projectOrderContactsForRoles/,
      );
    }
  });
});
