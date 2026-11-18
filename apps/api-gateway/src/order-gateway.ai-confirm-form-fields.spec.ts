import 'reflect-metadata';
import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import {
  defer,
  finalize,
  type Observable,
  of,
  switchMap,
  throwError,
  timer,
  TimeoutError,
} from 'rxjs';
import { Where_deliver } from '@app/common';
import { OrderGatewayController } from './order-gateway.controller';
import type { AiStatusPoller } from './ai/ai-status.poller';
import {
  AiConfirmOrderDto,
  AiConfirmRequestDto,
} from './dto/ai-order.swagger.dto';
import { CreateOrderRequestDto } from './dto/order.swagger.dto';

/** @nestjs/swagger `DECORATORS.API_MODEL_PROPERTIES` (chuqur import yo'q). */
const API_MODEL_PROPERTIES = 'swagger/apiModelProperties';
import {
  CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE,
  CHOSEN_OPERATOR_SELF_ONLY_MESSAGE,
} from './order-create/order-chosen-operator';
import { OPERATOR_PHONE_REQUIRED_MESSAGE } from './order-create/order-operator-phone';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * `POST /orders/ai-confirm` — qo'lda forma (`POST /orders`) maydonlari AI
 * tasdig'ida ham: «Operator» tanlovi (`orders[].operator_id`) va operator
 * raqami (`orders[].operator_phone`).
 *
 * Qoida `POST /orders` bilan AYNI (`createOrderInternal` →
 * `resolveChosenOrderOperator`); farqi faqat xato shaklida: ai-confirm har
 * buyurtmaga alohida natija beradi — POST /orders 400 matni
 * `{ ok: false, code: 'create_failed', reason }` bo'lib qaytadi, partiyaning
 * qolgani yaratiladi. Test ma'lumotlari sintetik.
 */

type Pattern = { cmd: string };
type SendPayload = Record<string, unknown> & {
  ids?: string[];
  id?: string;
  dto?: Record<string, unknown> & { phone_number?: string };
  draft_ids?: string[];
  market_id?: string;
  operator_id?: string;
};
type Fake = { send: jest.Mock<Observable<unknown>, [Pattern, SendPayload]> };

const fakeClient = (): Fake => ({
  send: jest.fn<Observable<unknown>, [Pattern, SendPayload]>(),
});
const asClient = (fake: Fake) => fake as unknown as ClientProxy;

const MARKET_ID = '77';
const OTHER_MARKET_ID = '78';
const OPERATOR_SELF = '501'; // MARKET_ID operatori (so'rovchi ham bo'ladi)
const DRAFT_ID = 'dddddddd-0000-4000-8000-000000000000';

type OperatorRow = {
  id: string;
  name: string;
  market_id: string;
  active: boolean;
};
/** identity `admins` jadvalining kerakli qismi (sintetik). */
const OPERATORS: OperatorRow[] = [
  {
    id: OPERATOR_SELF,
    name: 'Operator Self',
    market_id: MARKET_ID,
    active: true,
  },
  { id: '31', name: 'Operator Bir', market_id: MARKET_ID, active: true },
  { id: '32', name: 'Operator Nofaol', market_id: MARKET_ID, active: false },
  {
    id: '41',
    name: 'Operator Begona',
    market_id: OTHER_MARKET_ID,
    active: true,
  },
];

const phoneFor = (n: number) => `+998901${String(n).padStart(6, '0')}`;

const confirmOrder = (
  n: number,
  overrides: Partial<AiConfirmOrderDto> = {},
): AiConfirmOrderDto => ({
  customer: {
    name: `Mijoz ${n}`,
    phone_number: phoneFor(n),
    district_id: '12',
  },
  district_id: '12',
  items: [{ product_id: '15', quantity: 1 }],
  total_price: 100000 + n,
  where_deliver: Where_deliver.CENTER,
  draft_id: DRAFT_ID,
  ai_item_index: n,
  ...overrides,
});

const makeController = (
  market: Record<string, unknown> = { status: 'active', add_order: true },
) => {
  const order = fakeClient();
  const identity = fakeClient();
  const logistics = fakeClient();
  const branch = fakeClient();
  const file = fakeClient();
  const ai = fakeClient();
  const catalog = fakeClient();
  const config = {
    get: jest.fn((key: string) =>
      key === 'AI_ACK_CHECKS_ENFORCE' ? 'on' : undefined,
    ),
  };
  const poller = { getState: jest.fn(() => 'enabled') };

  // Xodim (registrator/menejer) — filialsiz (HQ).
  branch.send.mockImplementation(() => of({ data: null }));
  logistics.send.mockImplementation((_pattern, payload) =>
    of({
      data: (payload.ids ?? [])
        .filter((id) => id === '12')
        .map((id) => ({ id, name: 'Tuman', region_id: '1', isDeleted: false })),
    }),
  );
  catalog.send.mockImplementation((_pattern, payload) =>
    of({
      data: (payload.ids ?? [])
        .filter((id) => id === '15')
        .map((id) => ({ id, name: 'Mahsulot', user_id: MARKET_ID })),
    }),
  );
  identity.send.mockImplementation((pattern, payload) => {
    switch (pattern.cmd) {
      case 'identity.customer.create':
        return of({
          data: { id: `c${payload.dto?.phone_number ?? ''}` },
        });
      case 'identity.user.find_by_id': {
        const row = OPERATORS.find((op) => op.id === payload.id);
        return of({
          data: { id: payload.id, name: row?.name, market_id: MARKET_ID },
        });
      }
      case 'identity.market.find_by_id':
        return of({ data: { id: payload.id, ...market } });
      case 'identity.market_operator.selectable':
        return of({
          statusCode: 200,
          message: 'success',
          data: {
            items: OPERATORS.filter(
              (row) =>
                row.active &&
                row.market_id === payload.market_id &&
                (!payload.operator_id || row.id === payload.operator_id),
            ).map((row) => ({ id: row.id, name: row.name })),
          },
        });
      default:
        return of({ data: null });
    }
  });
  let nextOrderId = 1000;
  order.send.mockImplementation(() => of({ id: String(nextOrderId++) }));
  ai.send.mockImplementation((pattern, payload) =>
    pattern.cmd === 'ai.draft.confirm_context'
      ? of({
          drafts: (payload.draft_ids ?? []).map((draft_id) => ({ draft_id })),
        })
      : of({ updated: 1 }),
  );

  const controller = new OrderGatewayController(
    asClient(order),
    asClient(identity),
    asClient(logistics),
    asClient(branch),
    asClient(file),
    asClient(ai),
    asClient(catalog),
    config as unknown as ConfigService,
    poller as unknown as AiStatusPoller,
  );
  return { controller, order, identity };
};

const marketReq = {
  user: { sub: MARKET_ID, username: 'market', roles: ['market'] },
};
const operatorReq = {
  user: { sub: OPERATOR_SELF, username: 'op', roles: ['market_operator'] },
};
const staffReq = (role: string) => ({
  user: { sub: '9', username: role, roles: [role] },
});

const sendsOf = (fake: Fake, cmd: string) =>
  fake.send.mock.calls.filter(([pattern]) => pattern.cmd === cmd);
const createdPayloads = (order: Fake) =>
  sendsOf(order, 'order.create').map(([, payload]) => payload);

/** Global pipe (main.ts) bilan AYNI sozlama. */
const pipe = new UzValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validateBody = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: AiConfirmRequestDto,
  }) as Promise<AiConfirmRequestDto>;

describe('POST /orders/ai-confirm — orders[].operator_id («Operator» tanlovi)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('DTO (POST /orders bilan ayni tekshiruv)', () => {
    it('qabul qilinadi; son → satr, bo`sh satr → tanlanmagan', async () => {
      const dto = await validateBody({
        orders: [
          { ...confirmOrder(1), operator_id: '31' },
          { ...confirmOrder(2), operator_id: 31 },
          { ...confirmOrder(3), operator_id: '  ' },
        ],
      });
      expect(dto.orders.map((o) => o.operator_id)).toEqual([
        '31',
        '31',
        undefined,
      ]);
    });

    it('raqam bo`lmasa — 400 (POST /orders xabari)', async () => {
      await expect(
        validateBody({ orders: [{ ...confirmOrder(1), operator_id: 'abc' }] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('bot payloadi (operator_id siz) o`zgarmagan holda o`tadi', async () => {
      const dto = await validateBody({
        orders: [{ ...confirmOrder(1), operator: 'operator matni' }],
      });
      expect(dto.orders[0].operator_id).toBeUndefined();
      expect(dto.orders[0].operator).toBe('operator matni');
    });
  });

  it('⭐ market faol operatorini tanlaydi → operator_id + ismi (matn e`tiborsiz), verified_operator_id', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { operator_id: '31', operator: 'boshqa matn' }),
        ],
      },
      marketReq,
    );

    expect(res.data.results).toEqual([
      expect.objectContaining({ index: 0, ok: true, order_id: '1000' }),
    ]);
    const [sent] = createdPayloads(fx.order);
    expect(sent.dto).toMatchObject({
      market_id: MARKET_ID,
      operator_id: '31',
      operator: 'Operator Bir',
    });
    expect(sent.verified_operator_id).toBe('31');
    // Tekshiruv — server aniqlagan market bo'yicha, ro'yxat bilan AYNI RPC.
    expect(
      sendsOf(fx.identity, 'identity.market_operator.selectable').map(
        ([, payload]) => payload,
      ),
    ).toEqual([{ market_id: MARKET_ID, operator_id: '31' }]);
  });

  it.each([
    ['begona market operatori', '41'],
    ['nofaol operator', '32'],
    ["mavjud bo'lmagan operator", '999'],
  ])(
    '%s → shu buyurtma create_failed (POST /orders 400 matni), mijoz yaratilmaydi, qolgani yaratiladi',
    async (_label, operatorId) => {
      const fx = makeController();
      const res = await fx.controller.aiConfirm(
        {
          orders: [
            confirmOrder(1, { operator_id: operatorId }),
            confirmOrder(2),
          ],
        },
        marketReq,
      );

      expect(res.data.results).toEqual([
        {
          index: 0,
          ok: false,
          code: 'create_failed',
          reason: CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE,
        },
        expect.objectContaining({ index: 1, ok: true }),
      ]);
      const customers = sendsOf(fx.identity, 'identity.customer.create').map(
        ([, payload]) => payload.dto?.phone_number,
      );
      expect(customers).toEqual([phoneFor(2)]);
      expect(createdPayloads(fx.order)).toHaveLength(1);
    },
  );

  it('market operatori boshqa operatorni tanlay olmaydi (self-only), o`zini — mumkin', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { operator_id: '31' }),
          confirmOrder(2, { operator_id: OPERATOR_SELF }),
        ],
      },
      operatorReq,
    );

    expect(res.data.results).toEqual([
      {
        index: 0,
        ok: false,
        code: 'create_failed',
        reason: CHOSEN_OPERATOR_SELF_ONLY_MESSAGE,
      },
      expect.objectContaining({ index: 1, ok: true }),
    ]);
    const [sent] = createdPayloads(fx.order);
    expect(sent.dto).toMatchObject({
      operator_id: OPERATOR_SELF,
      operator: 'Operator Self',
    });
    expect(sent.verified_operator_id).toBe(OPERATOR_SELF);
  });

  it('berilmasa — avvalgi xulq: tekshiruv yo`q, matn yoziladi, operator_id rol bo`yicha', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { operator: 'operator matni' })] },
      marketReq,
    );
    await fx.controller.aiConfirm({ orders: [confirmOrder(2)] }, operatorReq);

    expect(
      sendsOf(fx.identity, 'identity.market_operator.selectable'),
    ).toHaveLength(0);
    const [byMarket, byOperator] = createdPayloads(fx.order);
    expect(byMarket.dto).toMatchObject({
      operator: 'Operator Matni',
      operator_id: null,
    });
    expect(byMarket).not.toHaveProperty('verified_operator_id');
    expect(byMarket.dto).not.toHaveProperty('verified_operator_id');
    // Market operatori — o'zi (ismi bilan), avvalgidek.
    expect(byOperator.dto).toMatchObject({
      operator: 'Operator Self',
      operator_id: OPERATOR_SELF,
    });
    expect(byOperator).not.toHaveProperty('verified_operator_id');
  });

  it.each(['registrator', 'admin', 'manager'])(
    '%s + tanadagi market_id: shu market operatori — qabul, boshqa market operatori — create_failed',
    async (role) => {
      const fx = makeController();
      const res = await fx.controller.aiConfirm(
        {
          market_id: MARKET_ID,
          orders: [
            confirmOrder(1, { operator_id: '31' }),
            confirmOrder(2, { operator_id: '41' }),
          ],
        },
        staffReq(role),
      );

      expect(res.data.results).toEqual([
        expect.objectContaining({ index: 0, ok: true }),
        {
          index: 1,
          ok: false,
          code: 'create_failed',
          reason: CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE,
        },
      ]);
      const sent = createdPayloads(fx.order);
      expect(sent).toHaveLength(1);
      expect(sent[0].dto).toMatchObject({
        market_id: MARKET_ID,
        operator_id: '31',
        operator: 'Operator Bir',
      });
      expect(sent[0].verified_operator_id).toBe('31');
      // Tekshiruv — tanadagi market bo'yicha.
      expect(
        sendsOf(fx.identity, 'identity.market_operator.selectable').map(
          ([, payload]) => payload.market_id,
        ),
      ).toEqual([MARKET_ID, MARKET_ID]);
    },
  );

  it.each([
    ['RPC xatosi', () => throwError(() => new Error('identity down'))],
    ['timeout', () => throwError(() => new TimeoutError())],
    [
      'RMQ xato obyekti',
      () => throwError(() => ({ status: 'error', message: 'x' })),
    ],
  ])(
    'selectable %s → validation_unavailable (yaratilmagan), mijoz va operatorsiz buyurtma saqlanmaydi',
    async (_label, failure) => {
      const fx = makeController();
      const base = fx.identity.send.getMockImplementation()!;
      fx.identity.send.mockImplementation((pattern, payload) =>
        pattern.cmd === 'identity.market_operator.selectable'
          ? failure()
          : base(pattern, payload),
      );
      const res = await fx.controller.aiConfirm(
        {
          orders: [confirmOrder(1, { operator_id: '31' }), confirmOrder(2)],
        },
        marketReq,
      );

      expect(res.data.results).toEqual([
        {
          index: 0,
          ok: false,
          code: 'validation_unavailable',
          reason: expect.stringContaining(
            'operatorni tekshirib',
          ) as unknown as string,
        },
        expect.objectContaining({ index: 1, ok: true }),
      ]);
      expect(
        sendsOf(fx.identity, 'identity.customer.create').map(
          ([, payload]) => payload.dto?.phone_number,
        ),
      ).toEqual([phoneFor(2)]);
      const sent = createdPayloads(fx.order);
      expect(sent).toHaveLength(1);
      expect(sent[0].dto).toMatchObject({ operator_id: null });
    },
  );

  it('turli operator_id lar — identity so`rovlari PARALLEL (ketma-ket emas)', async () => {
    const fx = makeController();
    const base = fx.identity.send.getMockImplementation()!;
    let inFlight = 0;
    let maxInFlight = 0;
    fx.identity.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'identity.market_operator.selectable'
        ? defer(() => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return timer(20).pipe(
              switchMap(() => base(pattern, payload)),
              finalize(() => {
                inFlight -= 1;
              }),
            );
          })
        : base(pattern, payload),
    );
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { operator_id: '31' }),
          confirmOrder(2, { operator_id: '41' }),
          confirmOrder(3, { operator_id: OPERATOR_SELF }),
        ],
      },
      marketReq,
    );

    expect(maxInFlight).toBe(3);
    expect(res.data.results.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it('bir xil operator_id partiyada — identity BIR marta so`raladi', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { operator_id: '31' }),
          confirmOrder(2, { operator_id: '31' }),
          confirmOrder(3, { operator_id: '41' }),
          confirmOrder(4, { operator_id: '41' }),
        ],
      },
      marketReq,
    );

    expect(res.data.results.map((r) => r.ok)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(
      sendsOf(fx.identity, 'identity.market_operator.selectable').map(
        ([, payload]) => payload.operator_id,
      ),
    ).toEqual(['31', '41']);
  });

  describe('DTO: musbat int8 (bigint toshib ketmasin)', () => {
    it.each([
      ['9999999999999999999'],
      ['9223372036854775808'],
      ['0'],
      ['031'],
      [2 ** 53 + 2],
      [-5],
      [3.5],
    ])('%p — 400', async (value) => {
      await expect(
        validateBody({ orders: [{ ...confirmOrder(1), operator_id: value }] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('chegaradagi qiymat qabul qilinadi', async () => {
      const dto = await validateBody({
        orders: [
          { ...confirmOrder(1), operator_id: '9223372036854775807' },
          { ...confirmOrder(2), operator_id: ' 31 ' },
        ],
      });
      expect(dto.orders.map((o) => o.operator_id)).toEqual([
        '9223372036854775807',
        '31',
      ]);
    });
  });
});

describe('POST /orders/ai-confirm — orders[].operator_phone (VRyloH62)', () => {
  /** Market: raqam majburiy, doimiy raqam yo'q. */
  const STRICT_MARKET = {
    status: 'active',
    add_order: true,
    require_operator_phone: true,
    default_operator_phone: null,
  };
  const DEFAULT_PHONE = '+998901234567';
  const FORM_PHONE = '+998907654321';

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('DTO (POST /orders bilan ayni tekshiruv)', () => {
    it.each([
      [AiConfirmOrderDto, 'operator_phone'],
      [CreateOrderRequestDto, 'operator_phone'],
      [CreateOrderRequestDto, 'secondary_operator_phone'],
    ] as const)(
      'swagger: %p.%s — string, nullable (`string | null` → "object" bo`lmasin)',
      (cls, key) => {
        const meta = Reflect.getMetadata(
          API_MODEL_PROPERTIES,
          cls.prototype,
          key,
        ) as { type?: unknown; nullable?: boolean };
        expect(meta.type).toBe(String);
        expect(meta.nullable).toBe(true);
      },
    );

    it('qabul qilinadi va normallashtiriladi; bo`sh satr — yuborilmagan', async () => {
      const dto = await validateBody({
        orders: [
          { ...confirmOrder(1), operator_phone: '90 765 43 21' },
          { ...confirmOrder(2), operator_phone: '0907654321' },
          { ...confirmOrder(3), operator_phone: FORM_PHONE },
          { ...confirmOrder(4), operator_phone: '  ' },
        ],
      });
      expect(dto.orders.map((o) => o.operator_phone)).toEqual([
        FORM_PHONE,
        FORM_PHONE,
        FORM_PHONE,
        undefined,
      ]);
    });

    it('noto`g`ri shakl — 400', async () => {
      await expect(
        validateBody({
          orders: [{ ...confirmOrder(1), operator_phone: '12345' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('raqam majburiy marketda raqamsiz AI buyurtma — create_failed (POST /orders 400 matni), mijoz yaratilmaydi', async () => {
    const fx = makeController(STRICT_MARKET);
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1)] },
      marketReq,
    );

    expect(res.data.results).toEqual([
      {
        index: 0,
        ok: false,
        code: 'create_failed',
        reason: OPERATOR_PHONE_REQUIRED_MESSAGE,
      },
    ]);
    expect(sendsOf(fx.identity, 'identity.customer.create')).toHaveLength(0);
    expect(createdPayloads(fx.order)).toHaveLength(0);
  });

  it('⭐ raqam majburiy marketda operator_phone bilan — yaratiladi, raqam 1-raqam', async () => {
    const fx = makeController(STRICT_MARKET);
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { operator_phone: FORM_PHONE })] },
      marketReq,
    );

    expect(res.data.results).toEqual([
      expect.objectContaining({ index: 0, ok: true }),
    ]);
    const [sent] = createdPayloads(fx.order);
    expect(sent.dto).toMatchObject({ operator_phone: FORM_PHONE });
    expect(sent.dto).not.toHaveProperty('secondary_operator_phone');
  });

  it('market doimiy raqami bor — u 1-raqam, formadagisi 2-raqam (bir xil bo`lsa takrorlanmaydi)', async () => {
    const fx = makeController({
      status: 'active',
      add_order: true,
      require_operator_phone: true,
      default_operator_phone: DEFAULT_PHONE,
    });
    await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { operator_phone: FORM_PHONE }),
          confirmOrder(2, { operator_phone: DEFAULT_PHONE }),
          confirmOrder(3),
        ],
      },
      marketReq,
    );

    const sent = createdPayloads(fx.order).map((payload) => ({
      operator_phone: payload.dto?.operator_phone,
      secondary_operator_phone: payload.dto?.secondary_operator_phone,
    }));
    expect(sent).toEqual([
      { operator_phone: DEFAULT_PHONE, secondary_operator_phone: FORM_PHONE },
      { operator_phone: DEFAULT_PHONE, secondary_operator_phone: undefined },
      { operator_phone: DEFAULT_PHONE, secondary_operator_phone: undefined },
    ]);
  });

  it('berilmasa, majburiy bo`lmagan market — avvalgi xulq (raqam yozilmaydi)', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1)] },
      marketReq,
    );

    expect(res.data.results[0]).toMatchObject({ ok: true });
    const [sent] = createdPayloads(fx.order);
    expect(sent.dto).not.toHaveProperty('operator_phone');
    expect(sent.dto).not.toHaveProperty('secondary_operator_phone');
  });
});
