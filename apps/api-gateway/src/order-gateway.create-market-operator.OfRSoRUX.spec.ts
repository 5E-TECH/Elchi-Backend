import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import { resolveOrderCreateRequestId } from './order-create/order-create-idempotency';

/**
 * OfRSoRUX (ega qarori 2026-10-19, MO-S3) — `POST /orders` MARKET_OPERATOR ga:
 * operator buyurtmani qo'lda ham yaratadi. Ichki mantiq (`createOrderInternal`)
 * AI yo'li bilan AYNI — bu spec uni qotiradi:
 *  1) @Roles da MARKET_OPERATOR;
 *  2) market — identity `user.market_id`, tanadagi `market_id` E'TIBORSIZ
 *     (tanlov: jimgina ustidan yoziladi, MARKET roli bilan bir xil);
 *     marketga biriktirilmagan — 400, mijoz yaratilmaydi;
 *  3) `operator` bo'sh — operator ismi; `operator_id` — operatorning o'zi;
 *  4) Idempotency-Key (gpCIsGjH) operator uchun ham `idem:` request_id;
 *  5) javob proyeksiyasi — MARKET_HIDDEN_ORDER_FIELDS.
 * N11 qo'shimcha band: `GET /region`, `GET /district` MARKET_OPERATOR ga.
 */
const OPERATOR_ID = '26';
const OPERATOR_MARKET = '501';

const dto = {
  market_id: '999', // begona market — e'tiborsiz qolishi kerak
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
  operatorMarketId?: string | null;
  operatorName?: string | null;
  market?: Record<string, unknown>;
}) {
  const orderClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'order.create'
        ? of({
            statusCode: 201,
            data: {
              id: '500',
              market_id: OPERATOR_MARKET,
              market_tariff: 20000,
              courier_tariff: 15000,
              courier_share: 15000,
              branch_share: 3000,
              branch_cashbox_amount: 3000,
            },
          })
        : of({}),
    ),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.customer.create') {
        return of({ data: { id: 'c-new' } });
      }
      if (pattern.cmd === 'identity.user.find_by_id') {
        return of({
          data: {
            id: payload?.id,
            name:
              opts?.operatorName === undefined
                ? 'Sevinch Operator'
                : opts.operatorName,
            market_id:
              opts?.operatorMarketId === undefined
                ? OPERATOR_MARKET
                : opts.operatorMarketId,
          },
        });
      }
      if (pattern.cmd === 'identity.market.find_by_id') {
        return of({
          data: {
            id: payload?.id,
            status: 'active',
            add_order: true,
            ...(opts?.market ?? {}),
          },
        });
      }
      return of({});
    }),
  };
  const controller = new OrderGatewayController(
    orderClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
    { send: jest.fn(() => of({ data: null })) } as any,
  );
  return { controller, orderClient, identityClient };
}

const operatorReq = () =>
  ({
    user: { sub: OPERATOR_ID, username: 'op', roles: ['market_operator'] },
  }) as any;

const sentCreate = (orderClient: { send: jest.Mock }) => {
  const calls = (orderClient.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string })?.cmd === 'order.create',
  );
  return calls as Array<
    [
      unknown,
      {
        dto: Record<string, unknown>;
        requester: { id: string; roles: string[] };
        request_id: string;
      },
    ]
  >;
};

const identityCalls = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string })?.cmd === cmd,
  );

const rolesOf = (proto: object, name: string) =>
  Reflect.getMetadata(
    ROLES_KEY,
    Object.getOwnPropertyDescriptor(proto, name)?.value as object,
  ) as string[];

describe('OfRSoRUX — POST /orders MARKET_OPERATOR (qo‘lda yaratish)', () => {
  it('@Roles: POST /orders da market_operator (avvalgi rollar qoladi)', () => {
    expect(rolesOf(OrderGatewayController.prototype, 'create').sort()).toEqual(
      [
        'admin',
        'superadmin',
        'registrator',
        'market',
        'manager',
        'branch',
        'market_operator',
      ].sort(),
    );
  });

  it('⭐ market — operator marketi; tanadagi market_id (999) E’TIBORSIZ', async () => {
    const { controller, orderClient, identityClient } = makeController();

    await controller.create(dto as any, operatorReq());

    const [[, payload]] = sentCreate(orderClient);
    expect(payload.dto.market_id).toBe(OPERATOR_MARKET);
    // Market tekshiruvi ham operator marketi bilan (begona emas).
    expect(
      identityCalls(identityClient, 'identity.market.find_by_id').map(
        (call) => (call[1] as { id: string }).id,
      ),
    ).toEqual([OPERATOR_MARKET]);
  });

  it('⭐ operator_id — operatorning o‘zi (komissiya/atributsiya), requester roli uzatiladi; filial/source qo‘yilmaydi', async () => {
    const { controller, orderClient } = makeController();

    await controller.create(
      {
        ...dto,
        operator_id: '5',
        branch_id: '22',
        source: 'branch',
        status: 'sold',
        courier_id: '289',
      } as any,
      operatorReq(),
    );

    const [[, payload]] = sentCreate(orderClient);
    expect(payload.dto).toMatchObject({
      operator_id: OPERATOR_ID,
      branch_id: null,
      source: undefined,
    });
    expect(payload.dto).not.toHaveProperty('status');
    expect(payload.dto).not.toHaveProperty('courier_id');
    expect(payload.requester).toEqual({
      id: OPERATOR_ID,
      roles: ['market_operator'],
    });
  });

  it('⭐ `operator` bo‘sh — server operator ismini yozadi', async () => {
    const { controller, orderClient } = makeController();

    await controller.create({ ...dto, operator: '  ' } as any, operatorReq());

    expect(sentCreate(orderClient)[0][1].dto.operator).toBe('Sevinch Operator');
  });

  it('`operator` yozilgan bo‘lsa — o‘zgarmaydi', async () => {
    const { controller, orderClient } = makeController();

    await controller.create(
      { ...dto, operator: 'Kecha smenasi' } as any,
      operatorReq(),
    );

    expect(sentCreate(orderClient)[0][1].dto.operator).toBe('Kecha smenasi');
  });

  it('⭐ marketga biriktirilmagan operator — 400, mijoz va buyurtma yaratilmaydi', async () => {
    const { controller, orderClient, identityClient } = makeController({
      operatorMarketId: null,
    });

    await expect(controller.create(dto as any, operatorReq())).rejects.toThrow(
      new BadRequestException(
        "Operator hech qaysi marketga biriktirilmagan — buyurtma yaratib bo'lmaydi",
      ),
    );
    expect(
      identityCalls(identityClient, 'identity.customer.create'),
    ).toHaveLength(0);
    expect(sentCreate(orderClient)).toHaveLength(0);
  });

  it('market add_order o‘chiq — operatorga ham 400 (market tomoni qoidasi)', async () => {
    const { controller, orderClient } = makeController({
      market: { add_order: false },
    });

    await expect(controller.create(dto as any, operatorReq())).rejects.toThrow(
      BadRequestException,
    );
    expect(sentCreate(orderClient)).toHaveLength(0);
  });

  it('⭐ Idempotency-Key (gpCIsGjH) operator uchun ham: `idem:<operator>:…`, bir xil kalit — bir xil request_id', async () => {
    const { controller, orderClient } = makeController();

    await controller.create(dto as any, operatorReq(), 'form-session-1');
    await controller.create(dto as any, operatorReq(), 'form-session-1');

    const ids = sentCreate(orderClient).map(
      ([, payload]) => payload.request_id,
    );
    expect(ids).toEqual([
      resolveOrderCreateRequestId(OPERATOR_ID, 'form-session-1'),
      resolveOrderCreateRequestId(OPERATOR_ID, 'form-session-1'),
    ]);
    expect(ids[0]).toMatch(/^idem:26:[0-9a-f]{64}$/);
  });

  it('⭐ javob — market proyeksiyasi (kuryer tarifi/ulushi, filial ulushi yo‘q)', async () => {
    const { controller } = makeController();

    const res: any = await controller.create(dto as any, operatorReq());

    expect(res.data.market_tariff).toBe(20000);
    for (const hidden of [
      'courier_tariff',
      'courier_share',
      'branch_share',
      'branch_cashbox_amount',
    ]) {
      expect(res.data).not.toHaveProperty(hidden);
    }
  });
});

describe('OfRSoRUX / N11 — GET /region, GET /district MARKET_OPERATOR ga', () => {
  it.each([['getAllRegions'], ['getAll']])(
    '%s — market_operator bor',
    (name) => {
      const roles = rolesOf(LogisticsGatewayController.prototype, name);
      expect(roles).toContain('market_operator');
      for (const kept of ['admin', 'superadmin', 'market', 'courier']) {
        expect(roles).toContain(kept);
      }
    },
  );

  it('yozish yo‘llari (POST/PATCH/DELETE region/district) operatorga ochilmagan', () => {
    for (const name of ['create', 'updateRegion', 'deleteRegion']) {
      const roles = rolesOf(LogisticsGatewayController.prototype, name);
      expect(roles).not.toContain('market_operator');
    }
  });
});
