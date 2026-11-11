import {
  BadRequestException,
  GatewayTimeoutException,
  ValidationPipe,
} from '@nestjs/common';
import { of, throwError, TimeoutError } from 'rxjs';
import {
  CreateExternalOrderRequestDto,
  CreateOrderRequestDto,
} from './dto/order.swagger.dto';
import { OrderGatewayController } from './order-gateway.controller';
import {
  CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE,
  CHOSEN_OPERATOR_SELF_ONLY_MESSAGE,
} from './order-create/order-chosen-operator';

/**
 * Buyurtma formasidagi «Operator» tanlovi — `POST /orders` `operator_id`
 * (ega: «loyihada operatorni tanlash imkoni yo'q»; BeePost
 * `order.service.ts:464-485`, `operator-assignment.util.ts`).
 *
 * Bu spec qotiradi:
 *  1) tanlangan operator buyurtmaning YAKUNIY marketida faol va
 *     o'chirilmagan bo'lsa — `operator_id` va `operator` = uning ismi
 *     (yozilgan matn e'tiborsiz), payload YUQORI darajasida
 *     `verified_operator_id` (order-service faqat shuni ishonadi);
 *  2) begona market / nofaol / o'chirilgan — 400, mijoz va buyurtma
 *     yaratilmaydi; admin ham tekshiriladi;
 *  3) market operatori faqat o'zini tanlaydi;
 *  4) `operator_id` berilmasa — har rolda avvalgi xulq.
 */
const MARKET_A = '201';
const MARKET_B = '202';
const OPERATOR_SELF = '26'; // market A operatori (so'rovchi bo'lganda ham)

type OperatorRow = {
  id: string;
  name: string;
  market_id: string | null;
  status: 'active' | 'inactive';
  isDeleted: boolean;
};

/** identity'dagi `admins` jadvalining kerakli qismi. */
const OPERATORS: OperatorRow[] = [
  {
    id: OPERATOR_SELF,
    name: 'Sevinch Operator',
    market_id: MARKET_A,
    status: 'active',
    isDeleted: false,
  },
  {
    id: '31',
    name: 'Dilnoza',
    market_id: MARKET_A,
    status: 'active',
    isDeleted: false,
  },
  {
    id: '32',
    name: 'Nofaol Nodir',
    market_id: MARKET_A,
    status: 'inactive',
    isDeleted: false,
  },
  {
    id: '33',
    name: "O'chirilgan Olim",
    market_id: MARKET_A,
    status: 'active',
    isDeleted: true,
  },
  {
    id: '41',
    name: 'B operatori',
    market_id: MARKET_B,
    status: 'active',
    isDeleted: false,
  },
];

/** identity `findSelectableMarketOperators` filtri (faol, o'chirilmagan, shu market). */
const selectableItems = (payload: {
  market_id?: string;
  operator_id?: string;
}) =>
  OPERATORS.filter(
    (row) =>
      row.market_id === payload.market_id &&
      row.status === 'active' &&
      !row.isDeleted &&
      (!payload.operator_id || row.id === payload.operator_id),
  ).map((row) => ({ id: row.id, name: row.name }));

const dto = {
  customer: {
    name: 'Ali',
    phone_number: '+998901112233',
    district_id: '5',
  },
  total_price: 120000,
  district_id: '5',
  region_id: '2',
  address: 'Chilonzor',
  items: [{ product_id: '10', quantity: 1 }],
};

function makeController(opts?: {
  selectable?: () => unknown;
  branchAssignment?: Record<string, unknown> | null;
}) {
  const orderClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'order.create'
        ? of({ statusCode: 201, data: { id: '500' } })
        : of({}),
    ),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload?: unknown) => {
      const body = (payload ?? {}) as Record<string, string | undefined>;
      if (pattern.cmd === 'identity.customer.create') {
        return of({ data: { id: 'c-new' } });
      }
      if (pattern.cmd === 'identity.market_operator.selectable') {
        if (opts?.selectable) {
          return opts.selectable() as ReturnType<typeof of>;
        }
        return of({
          statusCode: 200,
          message: 'success',
          data: { items: selectableItems(body) },
        });
      }
      if (pattern.cmd === 'identity.user.find_by_id') {
        const row = OPERATORS.find((op) => op.id === body.id);
        return of({
          data: {
            id: body.id,
            name: row?.name ?? 'Registrator Rustam',
            market_id: row?.market_id ?? null,
          },
        });
      }
      if (pattern.cmd === 'identity.market.find_by_id') {
        return of({ data: { id: body.id, status: 'active', add_order: true } });
      }
      return of({});
    }),
  };
  const branchClient = {
    send: jest.fn(() => of({ data: opts?.branchAssignment ?? null })),
  };
  const controller = new OrderGatewayController(
    orderClient as never,
    identityClient as never,
    { send: jest.fn(() => of({})) } as never,
    branchClient as never,
  );
  return { controller, orderClient, identityClient };
}

const userReq = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as never;

type SentCreate = {
  dto: Record<string, unknown>;
  requester: { id: string; roles: string[] };
  verified_operator_id?: string;
};

const sentCreates = (orderClient: { send: jest.Mock }) =>
  (orderClient.send.mock.calls as unknown[][])
    .filter((args) => (args[0] as { cmd?: string })?.cmd === 'order.create')
    .map((args) => args[1] as SentCreate);

const identityCalls = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string })?.cmd === cmd,
  );

describe('«Operator» tanlovi — POST /orders operator_id', () => {
  it('⭐ market o`z faol operatorini tanlaydi → operator_id + ismi (yozilgan matn e`tiborsiz), verified_operator_id', async () => {
    const { controller, orderClient, identityClient } = makeController();

    await controller.create(
      { ...dto, operator_id: '31', operator: 'Kimdir' },
      userReq(MARKET_A, ['market']),
    );

    const [sent] = sentCreates(orderClient);
    expect(sent.dto).toMatchObject({
      market_id: MARKET_A,
      operator_id: '31',
      operator: 'Dilnoza',
    });
    expect(sent.verified_operator_id).toBe('31');
    // Tekshiruv — yakuniy market (token) bo'yicha, ro'yxat bilan AYNI RPC.
    expect(
      identityCalls(identityClient, 'identity.market_operator.selectable').map(
        (call) => call[1],
      ),
    ).toEqual([{ market_id: MARKET_A, operator_id: '31' }]);
  });

  it.each([
    ['begona market operatori', '41'],
    ['nofaol operator', '32'],
    ['o`chirilgan operator', '33'],
    ['mavjud bo`lmagan id', '9999'],
  ])(
    '⭐ %s → 400, mijoz va buyurtma yaratilmaydi',
    async (_label, operatorId) => {
      const { controller, orderClient, identityClient } = makeController();

      await expect(
        controller.create(
          { ...dto, operator_id: operatorId },
          userReq(MARKET_A, ['market']),
        ),
      ).rejects.toThrow(
        new BadRequestException(CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE),
      );
      expect(
        identityCalls(identityClient, 'identity.customer.create'),
      ).toHaveLength(0);
      expect(sentCreates(orderClient)).toHaveLength(0);
    },
  );

  it('market tanadagi market_id (B) bilan ham B operatorini tanlay olmaydi — market tokendan', async () => {
    const { controller, orderClient } = makeController();

    await expect(
      controller.create(
        { ...dto, market_id: MARKET_B, operator_id: '41' },
        userReq(MARKET_A, ['market']),
      ),
    ).rejects.toThrow(CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE);
    expect(sentCreates(orderClient)).toHaveLength(0);
  });

  it('⭐ market operatori boshqa operatorni tanlasa → 400 (identity ro`yxati so`ralmaydi)', async () => {
    const { controller, orderClient, identityClient } = makeController();

    await expect(
      controller.create(
        { ...dto, operator_id: '31' },
        userReq(OPERATOR_SELF, ['market_operator']),
      ),
    ).rejects.toThrow(
      new BadRequestException(CHOSEN_OPERATOR_SELF_ONLY_MESSAGE),
    );
    expect(
      identityCalls(identityClient, 'identity.market_operator.selectable'),
    ).toHaveLength(0);
    expect(
      identityCalls(identityClient, 'identity.customer.create'),
    ).toHaveLength(0);
    expect(sentCreates(orderClient)).toHaveLength(0);
  });

  it('market operatori o`zini tanlasa → o`zi + ismi (yozilgan matn e`tiborsiz), marketi — biriktirilgani', async () => {
    const { controller, orderClient, identityClient } = makeController();

    await controller.create(
      {
        ...dto,
        market_id: MARKET_B,
        operator_id: `0${OPERATOR_SELF}`,
        operator: 'Kecha smenasi',
      },
      userReq(OPERATOR_SELF, ['market_operator']),
    );

    const [sent] = sentCreates(orderClient);
    expect(sent.dto).toMatchObject({
      market_id: MARKET_A,
      operator_id: OPERATOR_SELF,
      operator: 'Sevinch Operator',
    });
    expect(sent.verified_operator_id).toBe(OPERATOR_SELF);
    expect(
      identityCalls(identityClient, 'identity.market_operator.selectable').map(
        (call) => call[1],
      ),
    ).toEqual([{ market_id: MARKET_A, operator_id: OPERATOR_SELF }]);
  });

  it('⭐ registrator tanlasa — tanlangan operator (o`zi emas), ismi ham uniki', async () => {
    const { controller, orderClient } = makeController();

    await controller.create(
      { ...dto, market_id: MARKET_A, operator_id: '31' },
      userReq('77', ['registrator']),
    );

    const [sent] = sentCreates(orderClient);
    expect(sent.dto).toMatchObject({ operator_id: '31', operator: 'Dilnoza' });
    expect(sent.verified_operator_id).toBe('31');
  });

  it.each([['admin'], ['superadmin']])(
    '⭐ %s ham tekshiriladi: begona — 400; to`g`ri — o`rnatiladi',
    async (role) => {
      const bad = makeController();
      await expect(
        bad.controller.create(
          { ...dto, market_id: MARKET_A, operator_id: '41' },
          userReq('1', [role]),
        ),
      ).rejects.toThrow(CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE);
      expect(sentCreates(bad.orderClient)).toHaveLength(0);

      const good = makeController();
      await good.controller.create(
        {
          ...dto,
          market_id: MARKET_B,
          operator_id: '41',
          operator: 'Matn',
        },
        userReq('1', [role]),
      );
      const [sent] = sentCreates(good.orderClient);
      expect(sent.dto).toMatchObject({
        market_id: MARKET_B,
        operator_id: '41',
        operator: 'B operatori',
      });
      expect(sent.verified_operator_id).toBe('41');
    },
  );

  it('menejer (filial xodimi) — tanadagi market bo`yicha tekshiriladi', async () => {
    const { controller, orderClient } = makeController({
      branchAssignment: { branch_id: '21', role: 'MANAGER' },
    });

    await controller.create(
      { ...dto, market_id: MARKET_B, operator_id: '41' },
      userReq('90', ['manager']),
    );
    expect(sentCreates(orderClient)[0].dto).toMatchObject({
      market_id: MARKET_B,
      operator_id: '41',
      operator: 'B operatori',
    });
  });

  it('identity javob bermasa — xato (fail-closed), buyurtma operatorsiz yaratilmaydi', async () => {
    const { controller, orderClient } = makeController({
      selectable: () => throwError(() => new TimeoutError()),
    });

    await expect(
      controller.create(
        { ...dto, operator_id: '31' },
        userReq(MARKET_A, ['market']),
      ),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(sentCreates(orderClient)).toHaveLength(0);
  });

  describe('operator_id berilmasa — avvalgi xulq (har rol)', () => {
    it('⭐ registrator: tanlamasa — operatorsiz (o`zi ham, ismi ham yozilmaydi; ega 2026-11-11)', async () => {
      const { controller, orderClient, identityClient } = makeController();

      await controller.create(
        { ...dto, market_id: MARKET_A },
        userReq('77', ['registrator']),
      );

      const [sent] = sentCreates(orderClient);
      expect(sent.dto.operator_id).toBeNull();
      expect(sent.dto).not.toHaveProperty('operator');
      expect(sent).not.toHaveProperty('verified_operator_id');
      expect(
        identityCalls(identityClient, 'identity.market_operator.selectable'),
      ).toHaveLength(0);
    });

    it('market: operator_id null, yozilgan matn saqlanadi (bosh harflar katta)', async () => {
      const { controller, orderClient } = makeController();

      await controller.create(
        { ...dto, operator: 'Kecha smenasi' },
        userReq(MARKET_A, ['market']),
      );

      const [sent] = sentCreates(orderClient);
      // 2026-11-04: yozilgan operator — odam ismi, har so'z bosh harfi katta.
      expect(sent.dto).toMatchObject({
        operator_id: null,
        operator: 'Kecha Smenasi',
      });
      expect(sent).not.toHaveProperty('verified_operator_id');
    });

    it('market operatori: operator_id — o`zi, bo`sh matn — uning ismi', async () => {
      const { controller, orderClient } = makeController();

      await controller.create(dto, userReq(OPERATOR_SELF, ['market_operator']));

      const [sent] = sentCreates(orderClient);
      expect(sent.dto).toMatchObject({
        market_id: MARKET_A,
        operator_id: OPERATOR_SELF,
        operator: 'Sevinch Operator',
      });
      expect(sent).not.toHaveProperty('verified_operator_id');
    });

    it.each([[undefined], [null], ['']])(
      'admin (operator_id=%p): operator_id null, matn saqlanadi, ro`yxat so`ralmaydi',
      async (operatorId) => {
        const { controller, orderClient, identityClient } = makeController();

        await controller.create(
          {
            ...dto,
            market_id: MARKET_A,
            operator: 'Admin yozgan',
            operator_id: operatorId,
          },
          userReq('1', ['admin']),
        );

        const [sent] = sentCreates(orderClient);
        // 2026-11-04: yozilgan operator — har so'z bosh harfi katta.
        expect(sent.dto).toMatchObject({
          operator_id: null,
          operator: 'Admin Yozgan',
        });
        expect(sent).not.toHaveProperty('verified_operator_id');
        expect(
          identityCalls(identityClient, 'identity.market_operator.selectable'),
        ).toHaveLength(0);
      },
    );

    it('Telegram bot yo`li: operator_id — operatorning o`zi, tekshiruv yo`q', async () => {
      const { controller, orderClient, identityClient } = makeController();

      await controller.botOrderCreate(
        {
          name: 'Ali',
          phone_number: '+998901112233',
          district_id: '5',
          order_item_info: [{ product_id: '10', quantity: 1 }],
          total_price: 50000,
        },
        userReq(OPERATOR_SELF, ['market_operator']),
      );

      const [sent] = sentCreates(orderClient);
      expect(sent.dto.operator_id).toBe(OPERATOR_SELF);
      expect(sent).not.toHaveProperty('verified_operator_id');
      expect(
        identityCalls(identityClient, 'identity.market_operator.selectable'),
      ).toHaveLength(0);
    });
  });
});

describe('«Operator» tanlovi — DTO (global ValidationPipe bilan bir xil)', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const body = {
    market_id: '16',
    customer: {
      name: 'TEST Mijoz',
      phone_number: '+998887009201',
      district_id: '173',
    },
    district_id: '173',
    items: [{ product_id: '4', quantity: 1 }],
    total_price: 100000,
  };
  const run = (value: unknown, metatype: unknown = CreateOrderRequestDto) =>
    pipe.transform(value, {
      type: 'body',
      metatype: metatype as never,
    }) as Promise<Record<string, unknown>>;

  it('raqamli satr va son → satr id', async () => {
    expect((await run({ ...body, operator_id: '26' })).operator_id).toBe('26');
    expect((await run({ ...body, operator_id: 26 })).operator_id).toBe('26');
  });

  it('bo`sh satr — tanlanmagan (undefined), null — ruxsat', async () => {
    expect((await run({ ...body, operator_id: '' })).operator_id).toBe(
      undefined,
    );
    expect((await run({ ...body, operator_id: '  ' })).operator_id).toBe(
      undefined,
    );
    expect((await run({ ...body, operator_id: null })).operator_id).toBeNull();
  });

  it.each([['abc'], ['-5'], ['1.5'], [{ id: '1' }], [['26']]])(
    'noto`g`ri operator_id %p → 400',
    async (value) => {
      await expect(run({ ...body, operator_id: value })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('POST /orders/external — operator_id avvalgidek 400 (forbidNonWhitelisted)', async () => {
    await expect(
      run({ ...body, operator_id: '26' }, CreateExternalOrderRequestDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Qolgan maydonlar avvalgidek o'tadi.
    const ok = await run(
      { ...body, external_id: 'EXT-1' },
      CreateExternalOrderRequestDto,
    );
    expect(ok).toMatchObject({ external_id: 'EXT-1', total_price: 100000 });
  });
});
