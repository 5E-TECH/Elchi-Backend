/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
  ValidationPipe,
  type ArgumentMetadata,
} from '@nestjs/common';
import { of } from 'rxjs';
import {
  ORDER_CREATE_ITEM_QUANTITY_MESSAGE,
  ORDER_CREATE_NO_DISTRICT_MESSAGE,
  ORDER_CREATE_NO_ITEMS_MESSAGE,
} from '@app/common';
import {
  CreateExternalOrderRequestDto,
  CreateOrderByTelegramBotRequestDto,
  CreateOrderRequestDto,
} from '../dto/order.swagger.dto';
import { OrderGatewayController } from '../order-gateway.controller';
import {
  assertOrderCreateContent,
  orderCreateDistrictId,
} from './order-create-content';

/**
 * IR2OHIiN — mahsulotsiz va tumansiz buyurtma yaratilmaydi (gateway qatlami).
 *
 *  - DTO (`main.ts` dagi AYNI ValidationPipe): `items` yo'q / bo'sh / miqdor 0
 *    → 400; tuman buyurtmada ham, inline mijozda ham, mavjud mijoz sifatida
 *    ham yo'q → 400; xabar bitta va o'zbekcha;
 *  - `createOrderInternal` (POST /orders, bot, AI): mijoz yaratilishidan OLDIN
 *    400 (yetim mijoz yo'q); tuman inline mijozdan buyurtmaga yoziladi;
 *  - `POST /orders/external` — AYNI qoida.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function validationMessages(
  metatype: ArgumentMetadata['metatype'],
  body: Record<string, unknown>,
): Promise<string[] | null> {
  try {
    await pipe.transform(body, { type: 'body', metatype });
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as {
      message?: string | string[];
    };
    return Array.isArray(response.message)
      ? response.message
      : [String(response.message)];
  }
}

const CUSTOMER = {
  name: 'TEST Mijoz',
  phone_number: '+998900000037',
  district_id: '12',
};
const ITEMS = [{ product_id: '41', quantity: 1 }];

describe('IR2OHIiN — CreateOrderRequestDto (POST /orders)', () => {
  const valid = {
    market_id: '37',
    customer: CUSTOMER,
    district_id: '12',
    region_id: '3',
    total_price: 150000,
    items: ITEMS,
  };

  it('to‘g‘ri so‘rov o‘tadi (regressiya)', async () => {
    expect(await validationMessages(CreateOrderRequestDto, valid)).toBeNull();
  });

  it.each([
    ['items yo‘q', { items: undefined }],
    ['items: []', { items: [] }],
    ['items: null', { items: null }],
    ['items massiv emas', { items: 'x' }],
  ])('%s → 400 «kamida bitta mahsulot» (bitta xabar)', async (_l, patch) => {
    const messages = await validationMessages(CreateOrderRequestDto, {
      ...valid,
      ...patch,
    });
    expect(messages).toEqual([ORDER_CREATE_NO_ITEMS_MESSAGE]);
  });

  it('miqdor 0 → 400', async () => {
    const messages = await validationMessages(CreateOrderRequestDto, {
      ...valid,
      items: [{ product_id: '41', quantity: 0 }],
    });
    expect(messages?.join(' ')).toMatch(/quantity kamida 1/);
  });

  it('tuman hech qayerda yo‘q (buyurtma, mijoz obyekti, customer_id) → 400 «tuman tanlanmagan»', async () => {
    const messages = await validationMessages(CreateOrderRequestDto, {
      market_id: '37',
      total_price: 150000,
      items: ITEMS,
    });
    expect(messages).toEqual([ORDER_CREATE_NO_DISTRICT_MESSAGE]);
  });

  it('district_id bo‘sh satr va boshqa manba yo‘q → 400', async () => {
    const messages = await validationMessages(CreateOrderRequestDto, {
      market_id: '37',
      total_price: 150000,
      items: ITEMS,
      district_id: '   ',
    });
    expect(messages).toEqual([ORDER_CREATE_NO_DISTRICT_MESSAGE]);
  });

  it('district_id son (satr emas) → 400 aniq xabar', async () => {
    const messages = await validationMessages(CreateOrderRequestDto, {
      ...valid,
      district_id: 12,
    });
    expect(messages).toEqual(["district_id satr (tuman ID) bo'lishi kerak"]);
  });

  it('tuman faqat mijozda (customer.district_id) — o‘tadi', async () => {
    const withoutDistrict: Record<string, unknown> = { ...valid };
    delete withoutDistrict.district_id;
    expect(
      await validationMessages(CreateOrderRequestDto, withoutDistrict),
    ).toBeNull();
  });

  it('mavjud mijoz (customer_id) — o‘tadi (tuman order-service da mijozdan)', async () => {
    expect(
      await validationMessages(CreateOrderRequestDto, {
        market_id: '37',
        customer_id: '801',
        total_price: 150000,
        items: ITEMS,
      }),
    ).toBeNull();
  });

  it('POST /orders/external DTO ham AYNI qoidani meros oladi', async () => {
    expect(
      await validationMessages(CreateExternalOrderRequestDto, {
        ...valid,
        items: [],
      }),
    ).toEqual([ORDER_CREATE_NO_ITEMS_MESSAGE]);
    expect(
      await validationMessages(CreateExternalOrderRequestDto, {
        market_id: '37',
        total_price: 1,
        items: ITEMS,
      }),
    ).toEqual([ORDER_CREATE_NO_DISTRICT_MESSAGE]);
  });

  it('bot DTO: order_item_info bo‘sh → 400 AYNI xabar', async () => {
    const messages = await validationMessages(
      CreateOrderByTelegramBotRequestDto,
      {
        name: 'TEST',
        phone_number: '+998900000037',
        district_id: '12',
        total_price: 1000,
        order_item_info: [],
      },
    );
    expect(messages).toEqual([ORDER_CREATE_NO_ITEMS_MESSAGE]);
  });
});

/**
 * Prod tester (2026-10-26, BE 7bff045): inline mijoz tumansiz yuborilsa 400
 * matni inglizcha validator matni bilan aralash edi — «customer.district_id
 * must be a string. customer.district_id should not be empty. Buyurtma uchun
 * tuman tanlanmagan». Endi bitta toza o'zbekcha xabar (javobda
 * `AllExceptionsFilter` massivni '. ' bilan qo'shadi).
 */
describe('IR2OHIiN — inline mijoz tumansiz: bitta o‘zbekcha xabar', () => {
  const base = {
    market_id: '37',
    total_price: 150000,
    items: ITEMS,
  };
  const ENGLISH = /must be|should not|customer\.district_id/;

  it.each([
    ['district_id yo‘q', {}],
    ['district_id: ""', { district_id: '' }],
    ['district_id: "   "', { district_id: '   ' }],
    ['district_id: null', { district_id: null }],
  ])(
    'customer.%s, buyurtmada ham yo‘q → faqat «tuman tanlanmagan»',
    async (_l, patch) => {
      const customer: Record<string, unknown> = { ...CUSTOMER, ...patch };
      if (!('district_id' in patch)) delete customer.district_id;
      const messages = await validationMessages(CreateOrderRequestDto, {
        ...base,
        customer,
      });
      expect(messages).toEqual([ORDER_CREATE_NO_DISTRICT_MESSAGE]);
      expect(messages?.join('. ')).toBe('Buyurtma uchun tuman tanlanmagan');
    },
  );

  it('buyurtmada district_id bor, inline mijozda yo‘q → baribir 400 (qoida o‘zgarmagan), xabar bitta va o‘zbekcha', async () => {
    const customer: Record<string, unknown> = { ...CUSTOMER };
    delete customer.district_id;
    const messages = await validationMessages(CreateOrderRequestDto, {
      ...base,
      district_id: '12',
      customer,
    });
    expect(messages).toEqual([ORDER_CREATE_NO_DISTRICT_MESSAGE]);
  });

  it('POST /orders/external DTO ham AYNI xabar', async () => {
    const customer: Record<string, unknown> = { ...CUSTOMER };
    delete customer.district_id;
    const messages = await validationMessages(CreateExternalOrderRequestDto, {
      ...base,
      customer,
    });
    expect(messages).toEqual([ORDER_CREATE_NO_DISTRICT_MESSAGE]);
  });

  it('mahsulot miqdori 0 + tumansiz mijoz → ikkala o‘zbekcha xabar, inglizcha tuman matni yo‘q', async () => {
    const customer: Record<string, unknown> = { ...CUSTOMER };
    delete customer.district_id;
    const messages = await validationMessages(CreateOrderRequestDto, {
      ...base,
      items: [{ product_id: '41', quantity: 0 }],
      customer,
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        ORDER_CREATE_NO_DISTRICT_MESSAGE,
        'items.0.quantity kamida 1 bo‘lishi kerak',
      ]),
    );
    expect(messages).toHaveLength(2);
    expect(messages?.join('. ')).not.toMatch(ENGLISH);
  });

  it('boshqa xabarlar o‘zgarmagan: customer.district_id son → «must be a string», ism yo‘q → avvalgidek', async () => {
    expect(
      await validationMessages(CreateOrderRequestDto, {
        ...base,
        customer: { ...CUSTOMER, district_id: 12 },
      }),
    ).toEqual(['customer.district_id must be a string']);
    const noName: Record<string, unknown> = { ...CUSTOMER };
    delete noName.name;
    const messages = await validationMessages(CreateOrderRequestDto, {
      ...base,
      customer: noName,
    });
    expect(messages).toEqual(
      expect.arrayContaining(['customer.name should not be empty']),
    );
    expect(messages).not.toContain(ORDER_CREATE_NO_DISTRICT_MESSAGE);
  });

  it('tuman mijozda bor — o‘tadi (regressiya)', async () => {
    expect(
      await validationMessages(CreateOrderRequestDto, {
        ...base,
        customer: CUSTOMER,
      }),
    ).toBeNull();
  });
});

describe('IR2OHIiN — assertOrderCreateContent / orderCreateDistrictId', () => {
  it.each([
    [{ items: undefined, district_id: '1' }, ORDER_CREATE_NO_ITEMS_MESSAGE],
    [{ items: [], district_id: '1' }, ORDER_CREATE_NO_ITEMS_MESSAGE],
    [
      { items: [{ product_id: '1', quantity: 0 }], district_id: '1' },
      ORDER_CREATE_ITEM_QUANTITY_MESSAGE,
    ],
    [
      { items: [{ product_id: '1', quantity: 1.5 }], district_id: '1' },
      ORDER_CREATE_ITEM_QUANTITY_MESSAGE,
    ],
    [{ items: ITEMS }, ORDER_CREATE_NO_DISTRICT_MESSAGE],
    [
      { items: ITEMS, customer: { district_id: '' } },
      ORDER_CREATE_NO_DISTRICT_MESSAGE,
    ],
  ])('%j → 400 %s', (dto, message) => {
    expect(() => assertOrderCreateContent(dto)).toThrow(
      new BadRequestException(message),
    );
  });

  it('miqdorsiz qator (sukut 1), tuman mijozda yoki customer_id — o‘tadi', () => {
    expect(() =>
      assertOrderCreateContent({
        items: [{ product_name: 'X' }],
        customer: { district_id: '7' },
      }),
    ).not.toThrow();
    expect(() =>
      assertOrderCreateContent({ items: ITEMS, customer_id: '801' }),
    ).not.toThrow();
  });

  it('buyurtma tumani ustun, bo‘lmasa inline mijozniki, bo‘lmasa null', () => {
    expect(
      orderCreateDistrictId({
        district_id: '5',
        customer: { district_id: '7' },
      }),
    ).toBe('5');
    expect(
      orderCreateDistrictId({
        district_id: ' ',
        customer: { district_id: '7' },
      }),
    ).toBe('7');
    expect(orderCreateDistrictId({ customer_id: '801' })).toBeNull();
  });
});

describe('IR2OHIiN — OrderGatewayController yaratish yo‘llari', () => {
  const makeController = (opts?: { operatorMarketId?: string | null }) => {
    const orderClient = {
      send: jest.fn(() => of({ statusCode: 201, data: { id: '500' } })),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'identity.customer.create') {
          return of({ data: { id: 'c-new' } });
        }
        if (pattern.cmd === 'identity.user.find_by_id') {
          return of({
            data: { market_id: opts?.operatorMarketId ?? '37', name: 'Op' },
          });
        }
        if (pattern.cmd === 'identity.market.find_by_id') {
          return of({ data: { status: 'active', add_order: true } });
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
    const sent = (cmd: string) =>
      (orderClient.send.mock.calls as unknown[][]).filter(
        (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
      );
    const customerCreates = () =>
      (identityClient.send.mock.calls as unknown[][]).filter(
        (args) =>
          (args[0] as { cmd?: string } | undefined)?.cmd ===
          'identity.customer.create',
      );
    return { controller, sent, customerCreates };
  };
  const req = (sub: string, roles: string[]) =>
    ({ user: { sub, username: 'u', roles } }) as any;

  it.each([
    ['items yo‘q', {}],
    ['items: []', { items: [] }],
    ['miqdor 0', { items: [{ product_id: '41', quantity: 0 }] }],
  ])(
    'POST /orders (market, DTO chetlab o‘tilsa ham): %s → 400, mijoz va buyurtma yaratilmaydi',
    async (_l, patch) => {
      const fx = makeController();
      await expect(
        fx.controller.create(
          { customer: CUSTOMER, total_price: 1000, ...patch } as any,
          req('37', ['market']),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fx.customerCreates()).toHaveLength(0);
      expect(fx.sent('order.create')).toHaveLength(0);
    },
  );

  it('POST /orders: tuman hech qayerda yo‘q → 400 «tuman tanlanmagan», hech narsa yaratilmaydi', async () => {
    const fx = makeController();
    await expect(
      fx.controller.create(
        { market_id: '37', total_price: 1000, items: ITEMS } as any,
        req('1', ['superadmin']),
      ),
    ).rejects.toThrow(ORDER_CREATE_NO_DISTRICT_MESSAGE);
    expect(fx.customerCreates()).toHaveLength(0);
    expect(fx.sent('order.create')).toHaveLength(0);
  });

  it('⭐ filial / registrator: tuman faqat mijozda — buyurtmaga YOZILADI', async () => {
    const fx = makeController();
    await fx.controller.create(
      {
        market_id: '37',
        customer: CUSTOMER,
        total_price: 1000,
        items: ITEMS,
      } as any,
      req('25', ['registrator']),
    );
    const [[, payload]] = fx.sent('order.create') as [
      unknown,
      { dto: Record<string, unknown> },
    ][];
    expect(payload.dto.district_id).toBe('12');
  });

  it('buyurtma tumani berilgan bo‘lsa — o‘sha (mijozniki emas)', async () => {
    const fx = makeController();
    await fx.controller.create(
      {
        market_id: '37',
        customer: CUSTOMER,
        district_id: '5',
        region_id: '2',
        total_price: 1000,
        items: ITEMS,
      } as any,
      req('1', ['superadmin']),
    );
    const [[, payload]] = fx.sent('order.create') as [
      unknown,
      { dto: Record<string, unknown> },
    ][];
    expect(payload.dto).toMatchObject({ district_id: '5', region_id: '2' });
  });

  it('⭐ Telegram bot: tuman bot formasidan (mijoz) buyurtmaga yoziladi', async () => {
    const fx = makeController();
    await fx.controller.botOrderCreate(
      {
        name: 'TEST',
        phone_number: '+998900000037',
        district_id: '12',
        total_price: 1000,
        order_item_info: ITEMS,
      } as any,
      req('77', ['market_operator']),
    );
    const [[, payload]] = fx.sent('order.create') as [
      unknown,
      { dto: Record<string, unknown> },
    ][];
    expect(payload.dto).toMatchObject({
      district_id: '12',
      items: ITEMS,
    });
  });

  it('Telegram bot: mahsulotsiz (DTO chetlab o‘tilsa) → 400, mijoz yaratilmaydi', async () => {
    const fx = makeController();
    await expect(
      fx.controller.botOrderCreate(
        {
          name: 'TEST',
          phone_number: '+998900000037',
          district_id: '12',
          total_price: 1000,
          order_item_info: [],
        } as any,
        req('77', ['market_operator']),
      ),
    ).rejects.toThrow(ORDER_CREATE_NO_ITEMS_MESSAGE);
    expect(fx.customerCreates()).toHaveLength(0);
  });

  it('POST /orders/external: mahsulotsiz → 400, mijoz yaratilmaydi; tuman mijozdan yoziladi', async () => {
    const fx = makeController();
    await expect(
      fx.controller.createExternal(
        { customer: CUSTOMER, total_price: 1000, items: [] } as any,
        req('37', ['market']),
      ),
    ).rejects.toThrow(ORDER_CREATE_NO_ITEMS_MESSAGE);
    expect(fx.customerCreates()).toHaveLength(0);

    await fx.controller.createExternal(
      { customer: CUSTOMER, total_price: 1000, items: ITEMS } as any,
      req('37', ['market']),
    );
    const [[, payload]] = fx.sent('order.external.create') as [
      unknown,
      { dto: Record<string, unknown> },
    ][];
    expect(payload.dto.district_id).toBe('12');
  });
});
