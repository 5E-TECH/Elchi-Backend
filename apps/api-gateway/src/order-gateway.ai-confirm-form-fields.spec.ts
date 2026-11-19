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
import { publicErrorFields, Where_deliver } from '@app/common';
import { OrderGatewayController } from './order-gateway.controller';
import type { AiStatusPoller } from './ai/ai-status.poller';
import {
  AiConfirmOrderDto,
  AiConfirmRequestDto,
} from './dto/ai-order.swagger.dto';
import {
  CreateExternalOrderRequestDto,
  CreateOrderRequestDto,
} from './dto/order.swagger.dto';

/** @nestjs/swagger `DECORATORS.API_MODEL_PROPERTIES` (chuqur import yo'q). */
const API_MODEL_PROPERTIES = 'swagger/apiModelProperties';
import {
  CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE,
  CHOSEN_OPERATOR_SELF_ONLY_MESSAGE,
  resolveChosenOrderOperator,
} from './order-create/order-chosen-operator';
import {
  OPERATOR_PHONE_REQUIRED_MESSAGE,
  resolveOrderOperatorPhones,
} from './order-create/order-operator-phone';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * `POST /orders/ai-confirm` — qo'lda forma (`POST /orders`) maydonlari AI
 * tasdig'ida ham: «Operator» tanlovi (`orders[].operator_id`) va operator
 * raqami (`orders[].operator_phone`), mavjud mijoz (`orders[].customer_id`).
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

/** identity mijoz kartalari va ularning buyurtmalari marketi (sintetik). */
const CUSTOMER_CARDS = [
  { id: '120', phone: '+998901110120', market_id: MARKET_ID },
  { id: '130', phone: '+998901110130', market_id: OTHER_MARKET_ID },
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
      case 'identity.customer.find_by_id': {
        const card = CUSTOMER_CARDS.find((row) => row.id === payload.id);
        // identity `findCustomerById`: yo'q — RpcException(errorRes(…, 404)).
        return card
          ? of({ data: { id: card.id, phone_number: card.phone } })
          : throwError(() => ({
              statusCode: 404,
              message: 'Customer topilmadi',
              data: null,
            }));
      }
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
  /** Tugagan barqaror kalitlar (`ai:<market>:<draft>:<idx>` → order_id). */
  const completed = new Map<string, string>();
  order.send.mockImplementation((pattern, payload) => {
    if (pattern.cmd === 'order.customer.market_summary') {
      // Mijozning shu marketda buyurtmasi bormi (`GET /customers/suggest` ham shu).
      const ids = (payload.customer_ids as string[] | undefined) ?? [];
      return of({
        data: {
          items: CUSTOMER_CARDS.filter(
            (row) =>
              row.market_id === payload.market_id && ids.includes(row.id),
          ).map((row) => ({ customer_id: row.id })),
        },
      });
    }
    if (pattern.cmd === 'order.ai_confirm.completed') {
      // order-service `findCompletedAiCreates`: faqat shu market kalitlari.
      const ids = (payload.request_ids as string[] | undefined) ?? [];
      return of({
        data: {
          items: ids
            .filter(
              (id) =>
                completed.has(id) && id.split(':')[1] === payload.market_id,
            )
            .map((id) => ({ request_id: id, order_id: completed.get(id) })),
        },
      });
    }
    // order.create: barqaror kalit (`executeIdempotent`) emulyatsiyasi.
    const requestId =
      typeof payload.request_id === 'string' ? payload.request_id : '';
    const existing = completed.get(requestId);
    if (existing) return of({ id: existing, idempotent_replay: true });
    const id = String(nextOrderId++);
    if (requestId.startsWith('ai:')) completed.set(requestId, id);
    return of({ id });
  });
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
  return { controller, order, identity, completed, catalog, logistics, ai };
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
          reason_code: 'CHOSEN_OPERATOR_NOT_SELECTABLE',
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
        reason_code: 'CHOSEN_OPERATOR_SELF_ONLY',
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
          reason_code: 'CHOSEN_OPERATOR_NOT_SELECTABLE',
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
        reason_code: 'OPERATOR_PHONE_REQUIRED',
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

describe('POST /orders/ai-confirm — orders[].customer_id (mavjud mijoz)', () => {
  const adminReq = {
    user: { sub: '1', username: 'admin', roles: ['admin'] },
  };
  const customerCreates = (identity: Fake) =>
    sendsOf(identity, 'identity.customer.create');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('DTO', () => {
    it('qabul qilinadi; son → satr, bo`sh satr — berilmagan', async () => {
      const dto = await validateBody({
        orders: [
          { ...confirmOrder(1), customer_id: '120' },
          { ...confirmOrder(2), customer_id: 120 },
          { ...confirmOrder(3), customer_id: ' ' },
        ],
      });
      expect(dto.orders.map((o) => o.customer_id)).toEqual([
        '120',
        '120',
        undefined,
      ]);
    });

    it.each([['c-1'], ['0120'], ['0'], ['9999999999999999999'], [2 ** 53 + 2]])(
      '%p — 400 (musbat int8, boshida nolsiz)',
      async (value) => {
        await expect(
          validateBody({
            orders: [{ ...confirmOrder(1), customer_id: value }],
          }),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it.each([
      ['POST /orders', CreateOrderRequestDto],
      [
        'POST /orders/external (OmitType merosi)',
        CreateExternalOrderRequestDto,
      ],
    ])('%s customer_id — ayni format', async (_label, metatype) => {
      const validateCreate = (customer_id: unknown) =>
        pipe.transform(
          {
            customer_id,
            district_id: '12',
            total_price: 1000,
            items: [{ product_id: '15', quantity: 1 }],
          },
          { type: 'body', metatype },
        ) as Promise<{ customer_id?: string }>;
      for (const bad of [
        'abc',
        'EXT-77',
        '3f9b1c9e-5a7d-4c1e-9b3a-2d4e6f8a0b1c',
        '-1',
        '1.5',
        '1e3',
        '+120',
        '0120',
        '0',
        '9223372036854775808',
        2 ** 53 + 2,
      ]) {
        await expect(validateCreate(bad)).rejects.toThrow(BadRequestException);
      }
      for (const [good, expected] of [
        ['120', '120'],
        [' 120 ', '120'],
        [120, '120'],
        ['9223372036854775807', '9223372036854775807'],
      ] as const) {
        await expect(validateCreate(good)).resolves.toMatchObject({
          customer_id: expected,
        });
      }
    });
  });

  it('⭐ shu marketda buyurtmasi bor mijoz — buyurtma o`sha kartaga, yangi karta ochilmaydi', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { customer_id: '120' })] },
      marketReq,
    );

    expect(res.data.results).toEqual([
      expect.objectContaining({ index: 0, ok: true }),
    ]);
    expect(customerCreates(fx.identity)).toHaveLength(0);
    const [sent] = createdPayloads(fx.order);
    expect(sent.dto).toMatchObject({
      customer_id: '120',
      market_id: MARKET_ID,
    });
    // Karta yangilanmaydi (update_customer_card berilmagan).
    expect(sendsOf(fx.identity, 'identity.customer.update')).toHaveLength(0);
  });

  it('boshqa market mijozi — telefon kartaga TO`LIQ mos kelsa qabul (GET /customers/suggest qoidasi)', async () => {
    const fx = makeController();
    const order = confirmOrder(1, { customer_id: '130' });
    order.customer.phone_number = '+998901110130';
    const res = await fx.controller.aiConfirm({ orders: [order] }, marketReq);

    expect(res.data.results[0]).toMatchObject({ ok: true });
    expect(customerCreates(fx.identity)).toHaveLength(0);
    expect(createdPayloads(fx.order)[0].dto).toMatchObject({
      customer_id: '130',
    });
  });

  it.each([
    ['begona mijoz, telefon mos emas', '130'],
    ['mavjud bo`lmagan mijoz', '999'],
  ])(
    '%s → shu buyurtma RAD (POST /orders 403 matni), telefon yo`liga tushmaydi, qolgani yaratiladi',
    async (_label, customerId) => {
      const fx = makeController();
      const res = await fx.controller.aiConfirm(
        {
          orders: [
            confirmOrder(1, { customer_id: customerId }),
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
          reason: expect.stringContaining(
            'customer_id qabul qilinmadi',
          ) as unknown as string,
        },
        expect.objectContaining({ index: 1, ok: true }),
      ]);
      // Rad etilgan buyurtma uchun mijoz ham, buyurtma ham yaratilmadi.
      expect(
        customerCreates(fx.identity).map(([, p]) => p.dto?.phone_number),
      ).toEqual([phoneFor(2)]);
      expect(createdPayloads(fx.order)).toHaveLength(1);
      expect(createdPayloads(fx.order)[0].dto).not.toMatchObject({
        customer_id: customerId,
      });
    },
  );

  it('doira tekshiruvi (order-service) javob bermasa — fail-closed: validation_unavailable, hech narsa yaratilmaydi', async () => {
    const fx = makeController();
    const base = fx.order.send.getMockImplementation()!;
    fx.order.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'order.customer.market_summary'
        ? throwError(() => new Error('rmq down'))
        : base(pattern, payload),
    );
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { customer_id: '120' })] },
      marketReq,
    );

    expect(res.data.results).toEqual([
      {
        index: 0,
        ok: false,
        code: 'validation_unavailable',
        reason: "Mijozni tekshirib bo'lmadi — birozdan so'ng qayta yuboring",
      },
    ]);
    expect(customerCreates(fx.identity)).toHaveLength(0);
    expect(createdPayloads(fx.order)).toHaveLength(0);
  });

  it.each([
    ['xato', () => new Error('identity down')],
    ['RMQ 500 obyekti', () => ({ statusCode: 500, message: 'x' })],
  ])(
    'boshqa market mijozi kartasi (identity) %s — 403 EMAS, validation_unavailable',
    async (_label, failure) => {
      const fx = makeController();
      const base = fx.identity.send.getMockImplementation()!;
      fx.identity.send.mockImplementation((pattern, payload) =>
        pattern.cmd === 'identity.customer.find_by_id'
          ? throwError(failure)
          : base(pattern, payload),
      );
      const order = confirmOrder(1, { customer_id: '130' });
      order.customer.phone_number = '+998901110130';
      const res = await fx.controller.aiConfirm({ orders: [order] }, marketReq);

      expect(res.data.results).toEqual([
        {
          index: 0,
          ok: false,
          code: 'validation_unavailable',
          reason: "Mijozni tekshirib bo'lmadi — birozdan so'ng qayta yuboring",
        },
      ]);
      expect(customerCreates(fx.identity)).toHaveLength(0);
      expect(createdPayloads(fx.order)).toHaveLength(0);
    },
  );

  it('admin + mavjud bo`lmagan id — POST /orders kabi tekshirilmaydi (hujjatlangan xulq)', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        market_id: MARKET_ID,
        orders: [confirmOrder(1, { customer_id: '999' })],
      },
      adminReq,
    );

    expect(res.data.results[0]).toMatchObject({ ok: true });
    expect(sendsOf(fx.identity, 'identity.customer.find_by_id')).toHaveLength(
      0,
    );
    expect(sendsOf(fx.order, 'order.customer.market_summary')).toHaveLength(0);
    expect(customerCreates(fx.identity)).toHaveLength(0);
    expect(createdPayloads(fx.order)[0].dto).toMatchObject({
      customer_id: '999',
    });
  });

  it.each([
    ['market_operator', operatorReq],
    ['registrator', staffReq('registrator')],
    ['manager', staffReq('manager')],
  ])(
    '%s + market_id: shu market mijozi qabul, begona (telefon mos emas) — rad; doira — server marketi',
    async (_role, req) => {
      const fx = makeController();
      const res = await fx.controller.aiConfirm(
        {
          // market_operator uchun e'tiborsiz (server o'zi aniqlaydi).
          market_id: MARKET_ID,
          orders: [
            confirmOrder(1, { customer_id: '120' }),
            confirmOrder(2, { customer_id: '130' }),
          ],
        },
        req,
      );

      expect(res.data.results).toEqual([
        expect.objectContaining({ index: 0, ok: true }),
        {
          index: 1,
          ok: false,
          code: 'create_failed',
          reason: expect.stringContaining(
            'customer_id qabul qilinmadi',
          ) as unknown as string,
        },
      ]);
      expect(
        sendsOf(fx.order, 'order.customer.market_summary').map(
          ([, payload]) => payload.market_id,
        ),
      ).toEqual([MARKET_ID, MARKET_ID]);
      const sent = createdPayloads(fx.order);
      expect(sent).toHaveLength(1);
      expect(sent[0].dto).toMatchObject({
        customer_id: '120',
        market_id: MARKET_ID,
      });
    },
  );

  it('shu market mijozi + update_customer_card: true — karta yangilanadi', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, {
            customer_id: '120',
            update_customer_card: true,
            customer: {
              name: 'Yangi Ism',
              phone_number: phoneFor(1),
              district_id: '12',
            },
          }),
        ],
      },
      marketReq,
    );

    const updates = sendsOf(fx.identity, 'identity.customer.update');
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toMatchObject({
      id: '120',
      dto: expect.objectContaining({ name: 'Yangi Ism' }) as unknown,
    });
    expect(createdPayloads(fx.order)[0].dto).toMatchObject({
      customer_id: '120',
    });
  });

  it('boshqa market mijozi + update_customer_card: true — 403 matni, buyurtma yaratilmaydi', async () => {
    const fx = makeController();
    const order = confirmOrder(1, {
      customer_id: '130',
      update_customer_card: true,
    });
    order.customer.phone_number = '+998901110130';
    const res = await fx.controller.aiConfirm({ orders: [order] }, marketReq);

    const cardUpdateDenied: unknown = expect.stringContaining(
      "Mijoz kartasini yangilab bo'lmaydi",
    );
    expect(res.data.results).toEqual([
      {
        index: 0,
        ok: false,
        code: 'create_failed',
        reason: cardUpdateDenied,
      },
    ]);
    expect(createdPayloads(fx.order)).toHaveLength(0);
    expect(sendsOf(fx.identity, 'identity.customer.update')).toHaveLength(0);
  });

  it('admin — POST /orders kabi istalgan mijoz (doira tekshiruvisiz)', async () => {
    const fx = makeController();
    const res = await fx.controller.aiConfirm(
      {
        market_id: MARKET_ID,
        orders: [confirmOrder(1, { customer_id: '130' })],
      },
      adminReq,
    );

    expect(res.data.results[0]).toMatchObject({ ok: true });
    expect(customerCreates(fx.identity)).toHaveLength(0);
    expect(sendsOf(fx.order, 'order.customer.market_summary')).toHaveLength(0);
    expect(createdPayloads(fx.order)[0].dto).toMatchObject({
      customer_id: '130',
    });
  });

  it('berilmasa — avvalgi xulq (telefon bo`yicha karta, doira tekshiruvi yo`q)', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);

    expect(sendsOf(fx.order, 'order.customer.market_summary')).toHaveLength(0);
    expect(customerCreates(fx.identity)).toHaveLength(1);
    expect(createdPayloads(fx.order)[0].dto).toMatchObject({
      customer_id: `c${phoneFor(1)}`,
    });
  });
});

describe('POST /orders 400 — `code` (#658) javobga chiqadi', () => {
  it.each([
    [
      'OPERATOR_PHONE_REQUIRED',
      () =>
        resolveOrderOperatorPhones({
          market: { require_operator_phone: true },
          strict: true,
        }),
    ],
    [
      'CHOSEN_OPERATOR_NOT_SELECTABLE',
      () =>
        resolveChosenOrderOperator({
          operatorId: '41',
          roles: ['market'],
          requesterId: MARKET_ID,
          marketId: MARKET_ID,
          loadSelectable: () => Promise.resolve({ data: { items: [] } }),
        }),
    ],
    [
      'CHOSEN_OPERATOR_SELF_ONLY',
      () =>
        resolveChosenOrderOperator({
          operatorId: '31',
          roles: ['market_operator'],
          requesterId: OPERATOR_SELF,
          marketId: MARKET_ID,
          loadSelectable: () => Promise.resolve({ data: { items: [] } }),
        }),
    ],
  ])('%s — 400 tanasida, filtr javobida ham', async (code, run) => {
    let error: unknown;
    try {
      await run();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code,
    });
    // Gateway filtri (`PUBLIC_ERROR_CODES`) kodni o'tkazadi.
    expect(
      publicErrorFields((error as BadRequestException).getResponse()),
    ).toEqual({ code });
  });
});

describe('POST /orders/ai-confirm — takror (barqaror kalit) tekshiruvlardan OLDIN', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** Operatorni "o'chiradi": selectable ro'yxati bo'sh qaytadi. */
  const deactivateOperators = (fx: ReturnType<typeof makeController>) => {
    const base = fx.identity.send.getMockImplementation()!;
    fx.identity.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'identity.market_operator.selectable'
        ? of({ data: { items: [] } })
        : base(pattern, payload),
    );
  };

  it('⭐ 1-urinish yaratdi, operator o`chirildi, takror → ok:true idempotent_replay:true (create_failed EMAS)', async () => {
    const fx = makeController();
    const first = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { operator_id: '31' })] },
      marketReq,
    );
    expect(first.data.results[0]).toMatchObject({
      ok: true,
      order_id: '1000',
      idempotent_replay: false,
    });

    deactivateOperators(fx);
    fx.identity.send.mockClear();
    fx.order.send.mockClear();
    const replay = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { operator_id: '31' })] },
      marketReq,
    );

    expect(replay.data.results).toEqual([
      { index: 0, ok: true, order_id: '1000', idempotent_replay: true },
    ]);
    // Takrorda operator ham, mijoz ham qayta so'ralmaydi, order.create yo'q.
    expect(
      sendsOf(fx.identity, 'identity.market_operator.selectable'),
    ).toHaveLength(0);
    expect(sendsOf(fx.identity, 'identity.customer.create')).toHaveLength(0);
    expect(createdPayloads(fx.order)).toHaveLength(0);
    // So'rov — server aniqlagan market kaliti bilan.
    expect(
      sendsOf(fx.order, 'order.ai_confirm.completed').map(([, p]) => p),
    ).toEqual([
      {
        market_id: MARKET_ID,
        request_ids: [`ai:${MARKET_ID}:${DRAFT_ID}:1`],
      },
    ]);
  });

  it('takror — raqam majburiy bo`lib qolgan marketda ham ok; yangi band esa tekshiriladi', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);
    // Market sozlamasi o'zgardi: raqam majburiy, doimiy raqam yo'q.
    const base = fx.identity.send.getMockImplementation()!;
    fx.identity.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'identity.market.find_by_id'
        ? of({
            data: {
              id: payload.id,
              status: 'active',
              add_order: true,
              require_operator_phone: true,
              default_operator_phone: null,
            },
          })
        : base(pattern, payload),
    );
    const replay = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1), confirmOrder(2)] },
      marketReq,
    );

    expect(replay.data.results).toEqual([
      { index: 0, ok: true, order_id: '1000', idempotent_replay: true },
      {
        index: 1,
        ok: false,
        code: 'create_failed',
        reason: OPERATOR_PHONE_REQUIRED_MESSAGE,
        reason_code: 'OPERATOR_PHONE_REQUIRED',
      },
    ]);
  });

  it('yangi band (boshqa ai_item_index) o`chirilgan operator bilan — avvalgidek create_failed', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { operator_id: '31' })] },
      marketReq,
    );
    deactivateOperators(fx);
    const res = await fx.controller.aiConfirm(
      {
        orders: [
          confirmOrder(1, { operator_id: '31' }),
          confirmOrder(2, { operator_id: '31' }),
        ],
      },
      marketReq,
    );

    expect(res.data.results).toEqual([
      { index: 0, ok: true, order_id: '1000', idempotent_replay: true },
      {
        index: 1,
        ok: false,
        code: 'create_failed',
        reason: CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE,
        reason_code: 'CHOSEN_OPERATOR_NOT_SELECTABLE',
      },
    ]);
  });

  it('takror so`rovi ishlamasa — avvalgi yo`l (tekshiruvlar + order.create idempotentligi)', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { operator_id: '31' })] },
      marketReq,
    );
    const base = fx.order.send.getMockImplementation()!;
    fx.order.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'order.ai_confirm.completed'
        ? throwError(() => new Error('no handler'))
        : base(pattern, payload),
    );
    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1, { operator_id: '31' })] },
      marketReq,
    );

    expect(res.data.results[0]).toMatchObject({
      ok: true,
      order_id: '1000',
      idempotent_replay: true,
    });
    expect(
      sendsOf(fx.identity, 'identity.market_operator.selectable'),
    ).toHaveLength(2);
  });

  /** Katalogdan mahsulot / logistikadan tuman "o'chiriladi" (find_by_ids bermaydi). */
  const deleteProduct = (fx: ReturnType<typeof makeController>) =>
    fx.catalog.send.mockImplementation(() => of({ data: [] }));
  const deleteDistrict = (fx: ReturnType<typeof makeController>) =>
    fx.logistics.send.mockImplementation(() => of({ data: [] }));

  it.each([
    ['mahsulot o`chirildi', deleteProduct],
    ['tuman o`chirildi', deleteDistrict],
  ])(
    '%s (urinishlar orasida) → takror ok:true idempotent_replay:true; yangi band — avvalgidek rad',
    async (_label, remove) => {
      const fx = makeController();
      await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);
      remove(fx);
      fx.order.send.mockClear();

      const res = await fx.controller.aiConfirm(
        { orders: [confirmOrder(1), confirmOrder(2)] },
        marketReq,
      );

      expect(res.data.results[0]).toEqual({
        index: 0,
        ok: true,
        order_id: '1000',
        idempotent_replay: true,
      });
      // Yangi band — tuman/mahsulot tekshiruvi susaymagan.
      expect(res.data.results[1]).toMatchObject({ index: 1, ok: false });
      expect(res.data.results[1].code).not.toBe('create_failed');
      expect(createdPayloads(fx.order)).toHaveLength(0);
    },
  );

  it('tuman/mahsulot tekshiruvi umuman ishlamasa — takror ok, yangi band validation_unavailable', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);
    fx.catalog.send.mockImplementation(() =>
      throwError(() => new Error('catalog down')),
    );

    const res = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1), confirmOrder(2)] },
      marketReq,
    );

    expect(res.data.results).toEqual([
      { index: 0, ok: true, order_id: '1000', idempotent_replay: true },
      expect.objectContaining({
        index: 1,
        ok: false,
        code: 'validation_unavailable',
      }),
    ]);
  });

  it('takror bandi partiya imzosini band qiladi — ayni mazmunli YANGI band duplicate_in_batch', async () => {
    const fx = makeController();
    await fx.controller.aiConfirm({ orders: [confirmOrder(1)] }, marketReq);
    const res = await fx.controller.aiConfirm(
      {
        orders: [confirmOrder(1), confirmOrder(1, { ai_item_index: 9 })],
      },
      marketReq,
    );

    expect(res.data.results.map((r) => [r.ok, r.code])).toEqual([
      [true, undefined],
      [false, 'duplicate_in_batch'],
    ]);
  });

  it('1-urinish timeout_unknown (bog`lanmagan) → takror buyurtmani draft/AI xarajatiga BOG`LAYDI', async () => {
    const fx = makeController();
    const base = fx.order.send.getMockImplementation()!;
    let firstCreate = true;
    fx.order.send.mockImplementation((pattern, payload) => {
      if (pattern.cmd === 'order.create' && firstCreate) {
        firstCreate = false;
        // Buyurtma yaratildi, lekin javob gateway'ga yetmadi.
        base(pattern, payload);
        return throwError(() => new TimeoutError());
      }
      return base(pattern, payload);
    });

    const first = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1)] },
      marketReq,
    );
    expect(first.data.results[0]).toMatchObject({
      ok: false,
      code: 'timeout_unknown',
    });
    expect(sendsOf(fx.ai, 'ai.usage.link_orders')).toHaveLength(0);

    const replay = await fx.controller.aiConfirm(
      { orders: [confirmOrder(1)] },
      marketReq,
    );
    expect(replay.data.results[0]).toEqual({
      index: 0,
      ok: true,
      order_id: '1000',
      idempotent_replay: true,
    });
    const links = sendsOf(fx.ai, 'ai.usage.link_orders');
    expect(links).toHaveLength(1);
    expect(links[0][1]).toMatchObject({
      draft_id: DRAFT_ID,
      market_id: MARKET_ID,
      order_ids: ['1000'],
      items: [expect.objectContaining({ item_index: 1, order_id: '1000' })],
    });
  });
});
