import { BadRequestException, ConflictException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import {
  mapOrderCreateInProgress,
  resolveOrderCreateRequestId,
} from './order-create/order-create-idempotency';
import { OPERATOR_PHONE_REQUIRED_MESSAGE } from './order-create/order-operator-phone';
import { contactPhonesOf } from './printer/printer.util';

/**
 * gpCIsGjH — `POST /orders` idempotentligi (gateway tomoni) va VRyloH62 —
 * operator ismi/raqamlari (yaratish va chek).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

const makeController = (opts?: {
  market?: Record<string, unknown>;
  userName?: string | null;
  operatorMarketId?: string | null;
  orderSend?: jest.Mock;
}) => {
  const orderClient = {
    send:
      opts?.orderSend ??
      jest.fn(() => of({ statusCode: 201, data: { id: '500' } })),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'identity.customer.create') {
        return of({ data: { id: 'c-new' } });
      }
      if (pattern.cmd === 'identity.user.find_by_id') {
        return of({
          data: {
            name: opts?.userName ?? null,
            market_id: opts?.operatorMarketId ?? null,
          },
        });
      }
      if (pattern.cmd === 'identity.market.find_by_id') {
        return of({
          data: { status: 'active', add_order: true, ...(opts?.market ?? {}) },
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
};

const sentCreate = (orderClient: { send: jest.Mock }) => {
  const call = (orderClient.send.mock.calls as unknown[][]).find(
    (args) => (args[0] as { cmd?: string })?.cmd === 'order.create',
  ) as [unknown, { dto: Record<string, unknown>; request_id?: string }];
  expect(call).toBeDefined();
  return call[1];
};

const userReq = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as any;

describe('gpCIsGjH — Idempotency-Key → request_id', () => {
  it('bir xil kalit + bir xil foydalanuvchi → bir xil `idem:` kaliti; boshqa foydalanuvchi — boshqa', () => {
    const a = resolveOrderCreateRequestId('201', 'form-session-1');
    expect(a).toMatch(/^idem:201:[0-9a-f]{64}$/);
    expect(resolveOrderCreateRequestId('201', ' form-session-1 ')).toBe(a);
    expect(resolveOrderCreateRequestId('202', 'form-session-1')).not.toBe(a);
    expect(resolveOrderCreateRequestId('201', 'form-session-2')).not.toBe(a);
  });

  it('kalitsiz — har chaqiruvga yangi UUID (RMQ qayta yetkazishi uchun barqaror)', () => {
    const x = resolveOrderCreateRequestId('201', undefined);
    const y = resolveOrderCreateRequestId('201', '  ');
    expect(x).toMatch(UUID_RE);
    expect(y).toMatch(UUID_RE);
    expect(x).not.toBe(y);
  });

  it('255 belgidan uzun kalit → 400', () => {
    expect(() => resolveOrderCreateRequestId('201', 'k'.repeat(256))).toThrow(
      BadRequestException,
    );
  });

  it('⭐ TC1: POST /orders Idempotency-Key bilan — order.create ga `idem:` request_id ketadi', async () => {
    const { controller, orderClient } = makeController();
    await controller.create(
      dto as any,
      userReq('201', ['market']),
      'form-session-1',
    );
    expect(sentCreate(orderClient).request_id).toBe(
      resolveOrderCreateRequestId('201', 'form-session-1'),
    );
  });

  it('⭐ TC2: kalitsiz POST — avvalgidek ishlaydi, lekin request_id DOIM bor (UUID)', async () => {
    const { controller, orderClient } = makeController();
    await controller.create(dto as any, userReq('201', ['market']));
    expect(sentCreate(orderClient).request_id).toMatch(UUID_RE);
  });

  it('⭐ TC4: birinchisi hali bajarilayotganda takroriy so`rov — aniq 409 (ichki kalit ko`rinmaydi)', async () => {
    const orderSend = jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'order.create'
        ? throwError(() => ({
            statusCode: 409,
            message: 'Idempotency in_progress for order.create:idem:201:abc',
          }))
        : of({}),
    );
    const { controller } = makeController({ orderSend });
    const error: unknown = await controller
      .create(dto as any, userReq('201', ['market']), 'form-session-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).not.toContain('idem:');
  });

  it('mapOrderCreateInProgress boshqa xatoni o`zgartirmaydi', () => {
    const other = new BadRequestException('x');
    expect(mapOrderCreateInProgress(other)).toBe(other);
  });
});

describe('VRyloH62 — operator ismi va raqamlari', () => {
  it('⭐ TC1: registrator `operator` ni bo`sh qoldirsa — uning ismi yoziladi', async () => {
    const { controller, orderClient } = makeController({
      userName: 'Registrator Rustam',
    });
    await controller.create(
      { ...dto, market_id: '121' } as any,
      userReq('77', ['registrator']),
    );
    expect(sentCreate(orderClient).dto).toMatchObject({
      operator: 'Registrator Rustam',
      operator_id: '77',
    });
  });

  it('registrator `operator` ni o`zi yozgan bo`lsa — o`zgarmaydi', async () => {
    const { controller, orderClient } = makeController({
      userName: 'Registrator Rustam',
    });
    await controller.create(
      { ...dto, market_id: '121', operator: 'Dilnoza' } as any,
      userReq('77', ['registrator']),
    );
    expect(sentCreate(orderClient).dto.operator).toBe('Dilnoza');
  });

  it('⭐ TC2: market operatori uchun ham avtomatik to`ladi', async () => {
    const { controller, orderClient } = makeController({
      userName: 'Operator Olim',
      operatorMarketId: '121',
    });
    await controller.create(dto as any, userReq('501', ['market_operator']));
    expect(sentCreate(orderClient).dto).toMatchObject({
      operator: 'Operator Olim',
      market_id: '121',
    });
  });

  it('⭐ TC3: require_operator_phone=true va default yo`q — raqamsiz yaratish 400, mijoz yaratilmaydi', async () => {
    const { controller, orderClient, identityClient } = makeController({
      market: { require_operator_phone: true, default_operator_phone: null },
    });
    const error: unknown = await controller
      .create(dto as any, userReq('201', ['market']))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      OPERATOR_PHONE_REQUIRED_MESSAGE,
    );
    expect(identityClient.send).not.toHaveBeenCalledWith(
      { cmd: 'identity.customer.create' },
      expect.anything(),
    );
    expect(
      (orderClient.send.mock.calls as unknown[][]).some(
        (args) => (args[0] as { cmd?: string })?.cmd === 'order.create',
      ),
    ).toBe(false);
  });

  it('⭐ TC4/TC5: default bor — 1-raqam default, formadagi raqam 2-raqam', async () => {
    const { controller, orderClient } = makeController({
      market: {
        require_operator_phone: true,
        default_operator_phone: '+998712000000',
      },
    });
    await controller.create(
      { ...dto, operator_phone: '90 123 45 67' } as any,
      userReq('201', ['market']),
    );
    expect(sentCreate(orderClient).dto).toMatchObject({
      operator_phone: '+998712000000',
      secondary_operator_phone: '+998901234567',
    });
  });

  it('majburiy, default yo`q, formada raqam bor — u 1-raqam', async () => {
    const { controller, orderClient } = makeController({
      market: { require_operator_phone: true, default_operator_phone: null },
    });
    await controller.create(
      { ...dto, operator_phone: '+998901234567' } as any,
      userReq('201', ['market']),
    );
    const sent = sentCreate(orderClient).dto;
    expect(sent.operator_phone).toBe('+998901234567');
    expect(sent.secondary_operator_phone).toBeUndefined();
  });

  it('majburiy emas va default yo`q — raqamsiz buyurtma avvalgidek', async () => {
    const { controller, orderClient } = makeController();
    await controller.create(dto as any, userReq('201', ['market']));
    const sent = sentCreate(orderClient).dto;
    expect(sent.operator_phone).toBeUndefined();
    expect(sent.secondary_operator_phone).toBeUndefined();
  });

  // T7 (QPq2C1co): chekdagi "Muammo bo'lsa" endi operator/market raqami EMAS —
  // faqat `problem_contacts` (viloyat logisti / zaxira raqamlar).
  it('⭐ TC4/TC5 chek: "Muammo bo`lsa" — problem_contacts tartib bilan; operator/market raqami chiqmaydi', () => {
    const both = contactPhonesOf({
      problem_contacts: [
        { name: null, phone: '+998712000000', source: 'support' },
        { name: null, phone: '+998901234567', source: 'support' },
      ],
    });
    expect(both).toEqual(['+998 71 200 00 00', '+998 90 123 45 67']);
    expect(
      contactPhonesOf({
        operator_phone: '+998712000000',
        market_phone: '+998900000037',
      } as never),
    ).toEqual([]);
  });
});
