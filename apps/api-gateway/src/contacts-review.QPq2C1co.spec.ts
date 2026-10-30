import { Test } from '@nestjs/testing';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { CatalogGatewayController } from './catalog-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import { ProblemContactsService } from './contacts/problem-contacts.service';
import { projectUserRowContactsForRoles } from './auth/order-contact-projection';
import { projectOrderTrackingForRoles } from './auth/order-tracking-projection';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import { OrderServiceService } from '../../order-service/src/order-service.service';

/**
 * T7 (QPq2C1co) — PR #585 ko'rib chiqish topilmalari: market / operator
 * telefonlari menejer, filial va kuryerga qolgan yo'llardan ham sizmaydi;
 * yorliq ro'yxatlarida `problem_contacts` bor.
 */
type Row = Record<string, any>;

const MARKET_PHONES = {
  telegram_username: 'test_market_tg',
  phone_number: '+998901234567',
  extra_number: '+998901234568',
  default_operator_phone: '+998901234569',
  username: 'test_market',
};

const market = (): Row => ({
  id: '37',
  name: 'TEST Market',
  role: 'market',
  status: 'active',
  market_responsible_id: '15',
  responsible: { id: '15', name: 'Mas`ul', phone_number: '+998905550000' },
  responsible_source: 'assigned',
  ...MARKET_PHONES,
});

const order = (over: Row = {}): Row => ({
  id: '81',
  market_id: '37',
  customer_id: '29',
  region_id: '1',
  status: 'new',
  operator_phone: '+998901234500',
  secondary_operator_phone: '+998901234501',
  customer: { id: '29', name: 'Mijoz', phone_number: '+998935556677' },
  market: { id: '37', name: 'TEST Market', ...MARKET_PHONES },
  ...over,
});

const LOGIST = { name: 'Logist', phone: '+998901112233', source: 'logist' };

const expectNoMarketContacts = (row: Row) => {
  expect(row).not.toHaveProperty('operator_phone');
  expect(row).not.toHaveProperty('secondary_operator_phone');
  for (const key of Object.keys(MARKET_PHONES)) {
    expect(row.market).not.toHaveProperty(key);
  }
  expect(row.customer.phone_number).toBe('+998935556677');
};

const user = (roles: string[], sub = '5') => ({
  user: { sub, username: 'u', roles },
});

const unwrap = (value: unknown): Promise<any> =>
  isObservable(value) ? firstValueFrom(value) : Promise.resolve(value);

describe('T7 #1 — GET /users va GET /users/:id: market qatori', () => {
  it('menejer GET /users?role=market — telefon, login, mas`ul yo`q; admin — bor', async () => {
    const identity = {
      send: jest.fn(() =>
        of({ statusCode: 200, data: { items: [market()], meta: {} } }),
      ),
    };
    const branch = {
      send: jest.fn(({ cmd }: { cmd: string }) =>
        cmd === 'branch.user.find_by_user'
          ? of({ data: { branch_id: '3', role: 'MANAGER' } })
          : of({ data: [] }),
      ),
    };
    const app = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: identity },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: branch },
      ],
    }).compile();
    const controller = app.get(ApiGatewayController);
    const list = (roles: string[]) =>
      controller.getUsers(
        undefined,
        'market',
        undefined,
        undefined,
        undefined,
        '1',
        '10',
        user(roles),
      ) as Promise<{ data: { items: Row[] } }>;

    const asManager = await list(['manager']);
    expect(asManager.data.items[0]).toEqual(
      expect.objectContaining({ id: '37', name: 'TEST Market' }),
    );
    for (const key of [
      ...Object.keys(MARKET_PHONES),
      'responsible',
      'responsible_source',
      'market_responsible_id',
    ]) {
      expect(asManager.data.items[0]).not.toHaveProperty(key);
    }
    const asAdmin = await list(['admin']);
    expect(asAdmin.data.items[0]).toMatchObject({
      phone_number: '+998901234567',
      responsible_source: 'assigned',
    });
  });

  it('registrator: telefon bor, mas`ul yo`q; market operatori ham yashiriladi', () => {
    const registrator = projectUserRowContactsForRoles(
      ['registrator'],
      market(),
    );
    expect(registrator.phone_number).toBe('+998901234567');
    expect(registrator).not.toHaveProperty('responsible');
    const operator = projectUserRowContactsForRoles(['manager'], {
      id: '40',
      role: 'market_operator',
      phone_number: '+998907770000',
    });
    expect(operator).toEqual({ id: '40', role: 'market_operator' });
    const courier = {
      id: '26',
      role: 'courier',
      phone_number: '+998911112233',
    };
    expect(projectUserRowContactsForRoles(['manager'], courier)).toBe(courier);
  });
});

describe('T7 #2 — GET /transfer-batches/:id va /remaining', () => {
  const batch = () => ({
    statusCode: 200,
    data: {
      id: '501',
      items: [{ id: '9001', order_id: '81', order: order() }],
    },
  });
  const controller = new BranchGatewayController({
    send: jest.fn(() => of(batch())),
  } as never);

  it.each([['manager'], ['branch']])(
    '%s — items[].order telefonsiz',
    async (role) => {
      for (const res of [
        await unwrap(controller.findTransferBatchById('501', user([role]))),
        await unwrap(
          controller.findRemainingTransferBatchById('501', user([role])),
        ),
      ]) {
        expectNoMarketContacts(res.data.items[0].order);
      }
    },
  );

  it('registrator — o`zgarishsiz', async () => {
    const res = await unwrap(
      controller.findTransferBatchById('501', user(['registrator'])),
    );
    expect(res.data.items[0].order.operator_phone).toBe('+998901234500');
  });
});

describe('T7 #3 — GET /post/return-requests/list', () => {
  it('menejer — guruh buyurtmalarida operator/market telefoni yo`q', async () => {
    const raw = order({ market: undefined });
    delete raw.market;
    const logistics = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: {
            groups: [{ courier: { id: '26', name: 'K' }, orders: [raw] }],
          },
        }),
      ),
    };
    const identity = {
      send: jest.fn(({ cmd }: { cmd: string }) =>
        cmd === 'identity.market.find_by_id'
          ? of({ data: market() })
          : of({
              data: { id: '29', name: 'Mijoz', phone_number: '+998935556677' },
            }),
      ),
    };
    const controller = new LogisticsGatewayController(
      logistics as never,
      identity as never,
    );
    const res: any = await controller.getReturnRequests(user(['manager']));
    expectNoMarketContacts(res.data.groups[0].orders[0]);
  });
});

/** OrderGatewayController — mock mijozlar bilan. */
function orderGateway(replies: Record<string, unknown>, problem = false) {
  const reply = (cmd: string) => of(replies[cmd] ?? { data: null });
  const orderClient = {
    send: jest.fn(({ cmd }: { cmd: string }) => reply(cmd)),
  };
  const identity = {
    send: jest.fn(({ cmd }: { cmd: string }) =>
      cmd === 'identity.contacts.problem'
        ? of({
            data: { regions: { '1': [LOGIST] }, districts: {}, fallback: [] },
          })
        : cmd === 'identity.market.find_by_ids'
          ? of({ data: [market()] })
          : reply(cmd),
    ),
  };
  const branch = {
    send: jest.fn(({ cmd }: { cmd: string }) =>
      cmd === 'branch.user.find_by_user'
        ? of({
            data: {
              branch_id: '3',
              role: 'MANAGER',
              branch: { id: '3', type: 'REGIONAL' },
            },
          })
        : of({ data: [] }),
    ),
  };
  return new OrderGatewayController(
    orderClient as never,
    identity as never,
    { send: jest.fn(() => of({ data: null })) } as never,
    branch as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    problem ? new ProblemContactsService(identity as never) : undefined,
  );
}

describe('T7 #4 — /orders/markets/:marketId/new|cancelled: problem_contacts', () => {
  const list = () => ({ statusCode: 200, data: [order()] });

  it.each([
    ['market', '37'],
    ['admin', '1'],
    ['manager', '5'],
  ])('%s — problem_contacts bor', async (role, sub) => {
    const controller = orderGateway(
      {
        'order.find_new_by_market_enriched': list(),
        'order.find_cancelled_by_market_enriched': list(),
        'order.find_cancelled_by_market': list(),
      },
      true,
    );
    const asNew: any = await controller.findNewOrdersByMarket(
      '37',
      user([role], sub),
    );
    expect(asNew.data[0].problem_contacts).toEqual([LOGIST]);
    if (role === 'manager') {
      expectNoMarketContacts(asNew.data[0]);
    } else {
      expect(asNew.data[0].market.phone_number).toBe('+998901234567');
    }
    const asCancelled: any = await controller.findCancelledOrdersByMarket(
      '37',
      user([role], sub),
    );
    expect(asCancelled.data[0].problem_contacts).toEqual([LOGIST]);
  });
});

describe('T7 #5/#6/#8 — courier/orders (filial), external/sources, PATCH /orders/:id', () => {
  it('#5 menejer GET /orders/courier/orders — telefonsiz, problem_contacts bor', async () => {
    const controller = orderGateway(
      {
        'order.find_all_enriched': {
          statusCode: 200,
          data: [order()],
          total: 1,
        },
      },
      true,
    );
    const res: any = await controller.findCourierOrdersLegacy(
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      user(['manager']),
    );
    expectNoMarketContacts(res.data.data[0]);
    expect(res.data.data[0].problem_contacts).toEqual([LOGIST]);
  });

  it('#6 menejer GET /orders/external/sources — market telefonsiz', async () => {
    const controller = orderGateway({
      'order.find_external_sources': [
        { market_id: '37', count: 2, market: market() },
      ],
    });
    const res: any = await controller.findExternalSources(user(['manager']));
    expect(res[0].market).not.toHaveProperty('phone_number');
    expect(res[0].market).not.toHaveProperty('username');
    expect(res[0].market.name).toBe('TEST Market');
  });

  it('#8 menejer PATCH /orders/:id — javobda operator telefonlari yo`q', async () => {
    const controller = orderGateway({
      'order.update_from_api': { statusCode: 200, data: order() },
    });
    jest
      .spyOn(controller as any, 'assertOrderInRequesterBranch')
      .mockResolvedValue(undefined);
    const res: any = await controller.update(
      '81',
      { comment: 'x' },
      user(['manager']),
    );
    expectNoMarketContacts(res.data);
  });
});

describe('T7 #7 — GET /orders/:id/tracking: market/operator aktyori', () => {
  const tracking = () => ({
    data: [
      {
        action: 'created',
        actor: {
          id: '37',
          name: 'TEST Market',
          role: 'market',
          ...MARKET_PHONES,
        },
        metadata: { operator_phone: '+998901234500' },
      },
      {
        action: 'sold',
        actor: {
          id: '26',
          name: 'Kuryer',
          role: 'courier',
          phone_number: '+998911112233',
        },
      },
    ],
  });

  it.each([['courier'], ['manager'], ['branch']])(
    '%s — market aktyori {id, name, role}, xodim aktyori o`zgarmaydi',
    (role) => {
      const res: any = projectOrderTrackingForRoles([role], tracking());
      expect(res.data[0].actor).toEqual({
        id: '37',
        name: 'TEST Market',
        role: 'market',
      });
      expect(res.data[0].metadata).not.toHaveProperty('operator_phone');
      expect(res.data[1].actor.phone_number).toBe('+998911112233');
    },
  );

  it('admin — o`zgarishsiz', () => {
    const payload = tracking();
    expect(projectOrderTrackingForRoles(['admin'], payload)).toBe(payload);
  });

  it('order-service trackingActorLabel: market/operator — telefon/loginga qaytmaydi', () => {
    const service = Object.create(OrderServiceService.prototype) as {
      trackingActorLabel: (actor: Row | null, id?: string) => string;
    };
    expect(
      service.trackingActorLabel(
        { id: '37', name: null, role: 'market', ...MARKET_PHONES },
        '37',
      ),
    ).toBe('user ID: 37');
    expect(
      service.trackingActorLabel({
        id: '26',
        name: null,
        role: 'courier',
        phone_number: '+998911112233',
      }),
    ).toContain('+998911112233');
  });
});

describe('T7 #4 — buyurtmadagi market: Elchi mas`uli faqat SA/admin', () => {
  const withResponsible = () => ({
    data: order({
      market: {
        id: '37',
        name: 'TEST Market',
        market_responsible_id: '15',
        responsible: { id: '15' },
        responsible_source: 'assigned',
        ...MARKET_PHONES,
      },
    }),
  });

  it.each([['registrator'], ['logist'], ['market'], ['manager'], ['courier']])(
    '%s — market.market_responsible_id / responsible yo`q',
    (role) => {
      const res: any = projectOrderPayloadForRoles([role], withResponsible());
      for (const key of [
        'market_responsible_id',
        'responsible',
        'responsible_source',
      ]) {
        expect(res.data.market).not.toHaveProperty(key);
      }
      expect(res.data.market.name).toBe('TEST Market');
    },
  );

  it('registrator / logist — market telefoni QOLADI; admin — hammasi', () => {
    const registrator: any = projectOrderPayloadForRoles(
      ['registrator'],
      withResponsible(),
    );
    expect(registrator.data.market.phone_number).toBe('+998901234567');
    expect(registrator.data.operator_phone).toBe('+998901234500');
    const payload = withResponsible();
    expect(projectOrderPayloadForRoles(['admin'], payload)).toBe(payload);
  });
});

describe('T7 (2-ko`rib chiqish #1) — mahsulot endpointlari: market telefoni', () => {
  const product = () => ({
    id: '700',
    name: 'Kitob',
    user_id: '37',
    market: {
      id: '37',
      name: 'TEST Market',
      phone_number: '+998901234567',
      status: 'active',
    },
  });
  const build = () =>
    new CatalogGatewayController(
      {
        send: jest.fn(({ cmd }: { cmd: string }) =>
          of(
            cmd === 'catalog.product.find_all'
              ? { statusCode: 200, data: { items: [product()], total: 1 } }
              : { statusCode: 200, data: product() },
          ),
        ),
      } as never,
      { send: jest.fn() } as never,
    );

  it.each([['manager'], ['branch']])(
    '%s: /product, /product/market/:id, /product/by-code, /product/:id — phone_number yo`q',
    async (role) => {
      const controller = build();
      const lists = [
        await unwrap(
          controller.findAll(
            '37',
            undefined,
            undefined,
            undefined,
            undefined,
            user([role]),
          ),
        ),
        await unwrap(
          controller.getByMarketId(
            '37',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            user([role]),
          ),
        ),
      ];
      for (const res of lists) {
        expect(res.data.items[0].market).not.toHaveProperty('phone_number');
        expect(res.data.items[0].market.name).toBe('TEST Market');
      }
      for (const res of [
        await controller.findByCode('ABC', '37', user([role])),
        await controller.findById('700', user([role])),
      ]) {
        expect((res as any).data.market).not.toHaveProperty('phone_number');
      }
    },
  );

  it('registrator: telefon bor', async () => {
    const res = await unwrap(
      build().getByMarketId(
        '37',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        user(['registrator']),
      ),
    );
    expect(res.data.items[0].market.phone_number).toBe('+998901234567');
  });
});
