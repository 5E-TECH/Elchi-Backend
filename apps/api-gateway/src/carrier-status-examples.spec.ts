import { ExecutionContext, INestApplication } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { readFileSync } from 'fs';
import type { Server } from 'http';
import { join } from 'path';
import { of, throwError } from 'rxjs';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { CarrierGatewayController } from './carrier-gateway.controller';
import {
  CARRIER_API_SERVERS,
  buildCarrierSwaggerDocument,
} from './carrier-swagger';
import {
  CARRIER_STATUS_REQUEST_EXAMPLES,
  CarrierOrderStatus,
} from './dto/carrier.swagger.dto';
import { UzValidationPipe } from './validation/uz-validation.pipe';
import { OrderLifecycleService } from '../../order-service/src/lifecycle/order-lifecycle.service';
import {
  matchPartlySellItems,
  type PartlySellRequestItem,
} from '../../order-service/src/lifecycle/partly-sell-items';

/**
 * SWAGGER MISOLLARI ↔ HAQIQIY TEKSHIRUV (`POST /carrier/orders/{id}/status`).
 *
 * Tashqi dasturchi Swagger'dagi tayyor misolni ("Try it out" → Examples)
 * tanlab yuboradi — misol 400 qaytarsa, hujjat yolg'on gapirgan bo'ladi.
 * Shu bois HAR BIR misol endpoint ishlatadigan AYNI tekshiruvdan o'tkaziladi:
 *
 * 1. Global `UzValidationPipe` — `main.ts` dagi AYNI opsiyalar (whitelist,
 *    forbidNonWhitelisted, transform): DTO qoidalari, noma'lum maydon → 400.
 * 2. Kontroller tekshiruvlari (haqiqiy `CarrierGatewayController` HTTP
 *    orqali): buyurtma id, `Idempotency-Key`, status → kurier amali.
 * 3. order-service qoidalari, gateway'dan keyin, lekin pul mantiqidan OLDIN:
 *    bekor sababi (`resolveCancelReason` — OTHER izohsiz → 400), qisman
 *    sotuv qatorlari (`matchPartlySellItems` — har bir qator bo'lishi shart)
 *    va summa/son chegaralari (`partlySellOrder` boshidagi tekshiruvlar).
 *
 * Yangi misol qo'shilsa-yu biror qoidaga zid bo'lsa — shu spec yiqiladi.
 * Pastdagi "buzilgan misollar" testi tekshiruvning o'zi ishlashini kafolatlaydi.
 */

const STATUS_PATH = '/carrier/orders/{id}/status';

/** `main.ts` → `new UzValidationPipe({...})` bilan AYNI (pastda tekshiriladi). */
const GLOBAL_PIPE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
} as const;

const EXPECTED_SUMMARY =
  'Buyurtma holatini yuborish: sotildi (sold), qisman (partly_sold), bekor (cancelled)';

const EXPECTED_EXAMPLES: ReadonlyArray<[key: string, summary: string]> = [
  ['sold', 'Sotildi'],
  ['sold_exchange', 'Sotildi (almashtirish, eski tovar olindi)'],
  ['partly_sold', 'Qisman sotildi (har bir qator + sotilgan dona)'],
  ['cancelled', 'Bekor qilindi (mijoz rad etdi)'],
  ['cancelled_other', 'Bekor qilindi (boshqa sabab — izoh majburiy)'],
];

/**
 * Rollback YASHIRIN va sukut bo'yicha o'chiq (`rollback_enabled: false`):
 * Swagger'da misoli yo'q, yuborilsa noma'lum status kabi 400.
 */
const CARRIER = {
  id: '3',
  name: 'BTS',
  courier_user_id: '55',
  rollback_enabled: false,
};
const ORDER_ID = '1201';

/**
 * Misollar tegishli buyurtma: 2 qator, har biri 1 dona (partly_sold misoli
 * 5501 dan 1 dona, 5502 dan 0 dona sotadi).
 */
const ORDER_ITEMS = [
  { id: '5501', product_id: '1', product_name: 'Kurtka', quantity: 1 },
  { id: '5502', product_id: '2', product_name: 'Shim', quantity: 1 },
];
const ORDER_TOTAL = 250000;

/** Status → kontroller chaqiradigan kurier amali. */
const EXPECTED_CMD: Record<CarrierOrderStatus, string> = {
  [CarrierOrderStatus.SOLD]: 'order.sell',
  [CarrierOrderStatus.PARTLY_SOLD]: 'order.partly_sell',
  [CarrierOrderStatus.CANCELLED]: 'order.cancel',
  [CarrierOrderStatus.ROLLBACK]: 'order.rollback_waiting',
};

/** Amaldan keyingi buyurtma holati (kontrollerning eski-kalit tekshiruvi uchun). */
const AFTER_STATUS: Record<string, string> = {
  'order.sell': 'sold',
  'order.partly_sell': 'sold',
  'order.cancel': 'cancelled',
  'order.rollback_waiting': 'waiting',
};

type ActionCall = { cmd: string; dto: Record<string, unknown> };

/** ORDER RMQ mijozi o'rnida — holatli: amal buyurtmani keyingi holatga o'tkazadi. */
class FakeOrderClient {
  private status = 'waiting';
  calls: ActionCall[] = [];

  reset(initialStatus: string): void {
    this.status = initialStatus;
    this.calls = [];
  }

  private row() {
    return {
      id: ORDER_ID,
      status: this.status,
      courier_id: CARRIER.courier_user_id,
      holder_courier_id: CARRIER.courier_user_id,
      total_price: ORDER_TOTAL,
      items: ORDER_ITEMS,
    };
  }

  send = jest.fn((pattern: { cmd: string }, payload: { dto?: unknown }) => {
    if (
      pattern.cmd === 'order.find_by_id' ||
      pattern.cmd === 'order.find_by_id_enriched'
    ) {
      return of({ statusCode: 200, data: this.row() });
    }
    const after = AFTER_STATUS[pattern.cmd];
    if (!after) {
      return throwError(() => new Error(`kutilmagan cmd ${pattern.cmd}`));
    }
    this.calls.push({
      cmd: pattern.cmd,
      dto: (payload?.dto ?? {}) as Record<string, unknown>,
    });
    this.status = after;
    return of({ statusCode: 200, data: {} });
  });
}

const errorText = (error: unknown): string => {
  if (error instanceof RpcException) {
    const body = error.getError();
    if (typeof body === 'string') return body;
    const message = (body as { message?: unknown })?.message;
    return typeof message === 'string' ? message : JSON.stringify(message);
  }
  return (error as Error)?.message ?? String(error);
};

/**
 * order-service `resolveCancelReason` — HAQIQIY metod (nusxa emas): bekor
 * sababi yopiq ro'yxatdan, `OTHER` bo'lsa izoh majburiy.
 */
const resolveCancelReason = (reason: unknown, comment: unknown): unknown => {
  const proto = OrderLifecycleService.prototype as unknown as {
    resolveCancelReason: (reason: unknown, comment: unknown) => unknown;
    badRequest: (message: string) => never;
  };
  return proto.resolveCancelReason.call(
    { badRequest: proto.badRequest },
    reason,
    comment,
  );
};

/**
 * Kurier amali order-service'ga yetgandan keyingi, pul mantiqidan OLDINGI
 * qoidalar (shu buyurtma uchun). Qisman sotuvdagi son/summa chegaralari —
 * `OrderLifecycleService.partlySellOrder` boshidagi tekshiruvlar bilan bir xil.
 */
function assertOrderServiceRules(call: ActionCall): void {
  const { cmd, dto } = call;
  if (cmd === 'order.cancel') {
    resolveCancelReason(dto.reason, dto.comment);
    return;
  }
  if (cmd !== 'order.partly_sell') return;

  const info = (dto.order_item_info ?? []) as PartlySellRequestItem[];
  if (!info.length) throw new Error('order_item_info majburiy');
  const price = Number(dto.totalPrice ?? 0);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("totalPrice manfiy bo'lmasligi kerak");
  }
  if (price > ORDER_TOTAL) {
    throw new Error(
      'Qisman sotuv summasi buyurtma summasidan oshmasligi kerak',
    );
  }
  const oldQty = ORDER_ITEMS.reduce((sum, item) => sum + item.quantity, 0);
  const newQty = info.reduce((sum, item) => sum + Number(item.quantity), 0);
  if (newQty > oldQty) {
    throw new Error('Qisman sotish soni asl sondan oshmasligi kerak');
  }
  const { matches, cancelledItems } = matchPartlySellItems(ORDER_ITEMS, info);
  if (cancelledItems.length === 0 && !(price < ORDER_TOTAL)) {
    throw new Error("Mahsulot soni ham, summa ham o'zgarmagan");
  }
  const soldQty = matches.reduce((sum, match) => sum + match.quantity, 0);
  if (soldQty <= 0) {
    throw new Error('Kamida bitta mahsulot sotilishi shart');
  }
}

type RequestBodyContent = Record<
  string,
  {
    schema?: unknown;
    examples?: Record<string, { summary?: string; value?: unknown }>;
  }
>;

type StatusOperation = {
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    description?: string;
    schema?: { example?: unknown };
  }>;
  requestBody: { content: RequestBodyContent };
};

const statusOperation = (doc: OpenAPIObject): StatusOperation =>
  doc.paths[STATUS_PATH].post as unknown as StatusOperation;

const jsonExamples = (doc: OpenAPIObject) =>
  statusOperation(doc).requestBody.content['application/json'].examples ?? {};

const STATIC_SPEC = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/public/carrier-openapi.json'),
    'utf8',
  ),
) as OpenAPIObject;

describe('Carrier status Swagger misollari = endpoint tekshiruvi', () => {
  let app: INestApplication;
  let doc: OpenAPIObject;
  const orderClient = new FakeOrderClient();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000_000 }],
        }),
      ],
      controllers: [CarrierGatewayController],
      providers: [
        CarrierThrottlerGuard,
        { provide: 'ORDER', useValue: orderClient },
        { provide: 'LOGISTICS', useValue: { send: jest.fn() } },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'INTEGRATION', useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(CarrierApiKeyGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<{ carrier?: unknown }>();
          req.carrier = { ...CARRIER };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new UzValidationPipe({ ...GLOBAL_PIPE_OPTIONS }));
    await app.init();
    doc = buildCarrierSwaggerDocument(app, { servers: CARRIER_API_SERVERS });
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Tanani endpoint'dan o'tkazadi. `null` — qabul qilindi va order-service
   * qoidalariga ham mos; aks holda rad etish sababi.
   */
  async function verdict(body: unknown): Promise<string | null> {
    const status = (body as { status?: unknown })?.status;
    // rollback faqat sotilgan/bekor buyurtmaga; qolgani — `waiting` dan.
    orderClient.reset(
      status === CarrierOrderStatus.ROLLBACK ? 'sold' : 'waiting',
    );
    const idempotencyKey = statusOperation(doc).parameters?.find(
      (p) => p.in === 'header' && p.name === 'Idempotency-Key',
    )?.schema?.example;
    const res = await request(app.getHttpServer() as Server)
      .post(`/carrier/orders/${ORDER_ID}/status`)
      .set('Idempotency-Key', String(idempotencyKey))
      .send(body as object);
    if (res.status !== 200) {
      const { message } = res.body as { message?: unknown };
      return `HTTP ${res.status}: ${JSON.stringify(message)}`;
    }
    if (orderClient.calls.length !== 1) {
      return `kurier amali ${orderClient.calls.length} marta chaqirildi`;
    }
    const [call] = orderClient.calls;
    const expectedCmd = EXPECTED_CMD[status as CarrierOrderStatus];
    if (call.cmd !== expectedCmd) {
      return `kutilgan amal ${expectedCmd}, chaqirildi ${call.cmd}`;
    }
    try {
      assertOrderServiceRules(call);
    } catch (error) {
      return `order-service: ${errorText(error)}`;
    }
    return null;
  }

  it('summary — aniq matn; tavsif yangi jumla bilan boshlanadi', () => {
    for (const source of [doc, STATIC_SPEC]) {
      const op = statusOperation(source);
      expect(op.summary).toBe(EXPECTED_SUMMARY);
      expect(op.description).toMatch(
        /^Kuryeringiz posilkani topshirganda yoki topshira olmaganda shu so‘rovni yuboring — bizda buyurtma holati darhol o‘zgaradi\. /,
      );
      // Isbot fayli faqat multipart orqali — tavsifda aytilgan.
      expect(op.description).toContain('`multipart/form-data` bilan `proof`');
    }
  });

  it('misollar — kalitlar, tartib va sarlavhalar aniq', () => {
    expect(
      Object.entries(CARRIER_STATUS_REQUEST_EXAMPLES).map(([key, example]) => [
        key,
        example.summary,
      ]),
    ).toEqual(EXPECTED_EXAMPLES);
    for (const source of [doc, STATIC_SPEC]) {
      const examples = jsonExamples(source);
      expect(
        Object.entries(examples).map(([key, example]) => [
          key,
          example.summary,
        ]),
      ).toEqual(EXPECTED_EXAMPLES);
      // Hujjatdagi misol = kod'dagi misol (statik spec eskirmagan).
      expect(JSON.parse(JSON.stringify(examples))).toEqual(
        JSON.parse(JSON.stringify(CARRIER_STATUS_REQUEST_EXAMPLES)),
      );
    }
  });

  it('multipart: sxema o‘zgarmagan (DTO + proof), misollar yo‘q', () => {
    for (const source of [doc, STATIC_SPEC]) {
      const multipart =
        statusOperation(source).requestBody.content['multipart/form-data'];
      expect(multipart.examples).toBeUndefined();
      expect(JSON.stringify(multipart.schema)).toContain(
        '#/components/schemas/CarrierOrderStatusRequestDto',
      );
      expect(JSON.stringify(multipart.schema)).toContain('"format":"binary"');
    }
  });

  it('Idempotency-Key — majburiy, tavsifli, "Try it out" da OLDINDAN TO‘LDIRILMAYDI', () => {
    // Doimiy misol kalit har sinovda takrorlanib 422/409 berardi — maydon
    // ataylab bo‘sh, tavsif har safar yangi UUID kiritishni aytadi.
    for (const source of [doc, STATIC_SPEC]) {
      const header = statusOperation(source).parameters?.find(
        (p) => p.in === 'header' && p.name === 'Idempotency-Key',
      );
      expect(header).toMatchObject({ required: true });
      expect(header?.description).toContain('YANGI UUID');
      expect(header?.example).toBeUndefined();
      expect(header?.examples).toBeUndefined();
      expect(header?.schema?.example).toBeUndefined();
    }
  });

  it('spec global pipe opsiyalari = main.ts dagi UzValidationPipe opsiyalari', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const block = /new UzValidationPipe\(\{([\s\S]*?)\}\)/.exec(main)?.[1];
    expect(block).toBeDefined();
    const options = Object.fromEntries(
      [...(block ?? '').matchAll(/(\w+)\s*:\s*(true|false)/g)].map((m) => [
        m[1],
        m[2] === 'true',
      ]),
    );
    expect(options).toEqual(GLOBAL_PIPE_OPTIONS);
  });

  describe('⭐ har bir misol endpoint tekshiruvidan o‘tadi', () => {
    const sources: Array<[string, () => OpenAPIObject]> = [
      ['jonli /carrier-docs', () => doc],
      ['statik carrier-openapi.json', () => STATIC_SPEC],
    ];
    for (const [sourceName, source] of sources) {
      it(`${sourceName}: hamma misol qabul qilinadi`, async () => {
        const examples = jsonExamples(source());
        expect(Object.keys(examples).length).toBe(EXPECTED_EXAMPLES.length);
        const rejected: Record<string, string> = {};
        for (const [key, example] of Object.entries(examples)) {
          const reason = await verdict(example.value);
          if (reason) rejected[key] = reason;
        }
        expect(rejected).toEqual({});
      });
    }
  });

  it('⭐ tekshiruv ishlaydi: buzilgan misollar to‘g‘ri sabab bilan rad etiladi', async () => {
    const BOTH_ROWS = [
      { order_item_id: '5501', quantity: 1 },
      { order_item_id: '5502', quantity: 0 },
    ];
    /** [tana, rad etish sababidan parcha] */
    const broken: Record<string, [body: unknown, expected: string]> = {
      'noma’lum maydon': [
        { status: 'sold', extraCost: 5000 },
        'HTTP 400: ["extraCost:',
      ],
      'noma’lum status': [{ status: 'delivered' }, 'HTTP 400: ["status:'],
      'rollback (akkauntda o‘chiq — noma’lum status kabi)': [
        { status: 'rollback' },
        `HTTP 400: ["status: quyidagilardan biri bo'lishi kerak: sold, partly_sold, cancelled"]`,
      ],
      'cancelled + reason yo‘q': [
        { status: 'cancelled', comment: 'x' },
        'HTTP 400: ["reason:',
      ],
      'OTHER + izohsiz': [
        { status: 'cancelled', reason: 'OTHER' },
        "order-service: Sabab 'boshqa' (OTHER)",
      ],
      'OTHER + bo‘sh izoh': [
        { status: 'cancelled', reason: 'OTHER', comment: '  ' },
        "order-service: Sabab 'boshqa' (OTHER)",
      ],
      'partly_sold + total_price yo‘q': [
        { status: 'partly_sold', items: BOTH_ROWS },
        'HTTP 400: ["total_price:',
      ],
      'partly_sold + items yo‘q': [
        { status: 'partly_sold', total_price: 1000 },
        'HTTP 400: ["items:',
      ],
      'partly_sold — qator tushib qolgan': [
        {
          status: 'partly_sold',
          total_price: 150000,
          items: [{ order_item_id: '5501', quantity: 1 }],
        },
        'order-service: Product not found in request',
      ],
      'partly_sold — hech narsa sotilmagan': [
        {
          status: 'partly_sold',
          total_price: 0,
          items: [
            { order_item_id: '5501', quantity: 0 },
            { order_item_id: '5502', quantity: 0 },
          ],
        },
        'order-service: Kamida bitta mahsulot sotilishi shart',
      ],
      'partly_sold — summa buyurtmadan katta': [
        {
          status: 'partly_sold',
          total_price: ORDER_TOTAL + 1,
          items: BOTH_ROWS,
        },
        'order-service: Qisman sotuv summasi',
      ],
      'partly_sold — kasr dona': [
        {
          status: 'partly_sold',
          total_price: 150000,
          items: [
            { order_item_id: '5501', quantity: 0.5 },
            { order_item_id: '5502', quantity: 0 },
          ],
        },
        'HTTP 400: ["items.0.quantity:',
      ],
    };
    const wrong: Record<string, string | null> = {};
    for (const [name, [body, expected]] of Object.entries(broken)) {
      const reason = await verdict(body);
      if (!reason?.startsWith(expected)) wrong[name] = reason;
    }
    expect(wrong).toEqual({});
  });
});
