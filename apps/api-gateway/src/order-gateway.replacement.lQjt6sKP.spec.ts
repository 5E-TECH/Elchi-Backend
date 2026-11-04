import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { OrderGatewayController } from './order-gateway.controller';
import {
  CreateOrderRequestDto,
  PartlySellOrderRequestDto,
  SellOrderRequestDto,
} from './dto/order.swagger.dto';

/**
 * lQjt6sKP — ALMASHTIRISH (kafolat-swap) gateway qatlami:
 *   - `POST /orders` → `replaced_order_id` (faqat raqamli ID);
 *   - sotuv → `oldItemCollected` (multipart "true"/"1" ham);
 *   - `GET /orders/replaceable` — market doirasi, telefon qidiruvi, mijoz
 *     ismi; `GET /orders/replacement/returns`. Ikkalasi ham `:id` dan
 *     OLDIN (haqiqiy Nest routeri orqali).
 */
describe('lQjt6sKP — almashtirish: DTO', () => {
  const errorsOf = async <T extends object>(
    cls: new () => T,
    plain: Record<string, unknown>,
  ) => (await validate(plainToInstance(cls, plain))).map((e) => e.property);

  it('replaced_order_id: raqamli ID qabul qilinadi (son ham satrga aylanadi)', async () => {
    expect(
      await errorsOf(CreateOrderRequestDto, {
        market_id: '1',
        replaced_order_id: '1024',
      }),
    ).not.toContain('replaced_order_id');
    const dto = plainToInstance(CreateOrderRequestDto, {
      replaced_order_id: 1024,
    });
    expect(dto.replaced_order_id).toBe('1024');
  });

  it.each([['abc'], ['12a'], ['-5'], ['1'.repeat(19)]])(
    'replaced_order_id %p → validatsiya xatosi',
    async (value) => {
      expect(
        await errorsOf(CreateOrderRequestDto, { replaced_order_id: value }),
      ).toContain('replaced_order_id');
    },
  );

  it.each([
    [true, true],
    ['true', true],
    ['1', true],
    [false, false],
    ['false', false],
  ])('sotuv oldItemCollected %p → %p', async (value, expected) => {
    for (const cls of [SellOrderRequestDto, PartlySellOrderRequestDto]) {
      const dto = plainToInstance(cls as new () => object, {
        oldItemCollected: value,
      }) as { oldItemCollected?: boolean };
      expect(dto.oldItemCollected).toBe(expected);
    }
    expect(
      await errorsOf(SellOrderRequestDto, { oldItemCollected: value }),
    ).not.toContain('oldItemCollected');
  });

  it('sotuv oldItemCollected: boshqa qiymat → validatsiya xatosi', async () => {
    expect(
      await errorsOf(SellOrderRequestDto, { oldItemCollected: 'ha' }),
    ).toContain('oldItemCollected');
  });
});

describe('lQjt6sKP — almashtirish: GET /orders/replaceable va /replacement/returns', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const identitySend = jest.fn();
  const catalogSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };
  let user: { sub: string; roles: string[] } = {
    sub: '1',
    roles: ['superadmin'],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: noop },
        { provide: 'CATALOG', useValue: { send: catalogSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    orderSend.mockReset();
    identitySend.mockReset();
    catalogSend.mockReset();
    catalogSend.mockReturnValue(of({ data: [] }));
    orderSend.mockReturnValue(
      of({
        statusCode: 200,
        data: {
          items: [{ id: '120', customer_id: '801', items: [] }],
          total: 1,
          page: 1,
          limit: 20,
        },
      }),
    );
    identitySend.mockImplementation((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'identity.customer.find_by_ids'
          ? {
              data: [
                {
                  id: '801',
                  name: 'Ali Valiyev',
                  phone_number: '+998901234567',
                },
              ],
            }
          : { data: [{ id: '801' }, { id: '802' }] },
      ),
    );
    user = { sub: '1', roles: ['superadmin'] };
  });

  const orderCall = (cmd: string) =>
    orderSend.mock.calls.find(
      ([pattern]) => (pattern as { cmd: string }).cmd === cmd,
    )?.[1] as Record<string, unknown> | undefined;

  it("market roli: faqat o'z buyurtmalari (query market_id e'tiborsiz), mijoz ismi qo'shiladi", async () => {
    user = { sub: '37', roles: ['market'] };
    const res = await request(app.getHttpServer())
      .get('/orders/replaceable?market_id=3')
      .expect(200);

    expect(orderCall('order.replaceable')).toMatchObject({
      market_id: '37',
      page: 1,
      limit: 20,
    });
    expect(orderCall('order.find_by_id')).toBeUndefined();
    expect(res.body.data.items[0].customer).toEqual({
      id: '801',
      name: 'Ali Valiyev',
      phone_number: '+998901234567',
    });
  });

  it("mahsulot nomi bo'sh qatorlar katalogdan bitta so'rov bilan to'ldiriladi; katalog yiqilsa — nomsiz, 200", async () => {
    // Har chaqiruvga yangi obyekt: gateway qatorlarni joyida to'ldiradi.
    orderSend.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          items: [
            {
              id: '120',
              customer_id: '801',
              items: [
                { product_id: '5', product_name: null, quantity: 1 },
                { product_id: '6', product_name: "Qo'lda nom", quantity: 2 },
              ],
            },
            {
              id: '121',
              customer_id: '801',
              items: [{ product_id: '5', product_name: null, quantity: 3 }],
            },
          ],
          total: 2,
          page: 1,
          limit: 20,
        },
      }),
    );
    catalogSend.mockReturnValue(
      of({ data: [{ id: '5', name: 'Telefon chexoli' }] }),
    );
    const res = await request(app.getHttpServer())
      .get('/orders/replaceable?market_id=3')
      .expect(200);
    expect(catalogSend).toHaveBeenCalledTimes(1);
    expect(catalogSend).toHaveBeenCalledWith(
      { cmd: 'catalog.product.find_by_ids' },
      { ids: ['5'] },
    );
    expect(res.body.data.items[0].items).toEqual([
      { product_id: '5', product_name: 'Telefon chexoli', quantity: 1 },
      { product_id: '6', product_name: "Qo'lda nom", quantity: 2 },
    ]);
    expect(res.body.data.items[1].items[0].product_name).toBe(
      'Telefon chexoli',
    );

    catalogSend.mockReturnValue(throwError(() => new Error('catalog down')));
    const down = await request(app.getHttpServer())
      .get('/orders/replacement/returns')
      .expect(200);
    expect(down.body.data.items[0].items[0].product_name).toBeNull();
  });

  it("market operatori: marketi identity'dan (query market_id e'tiborsiz) — @Roles ochiq", async () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        OrderGatewayController.prototype.listReplaceableOrders,
      ),
    ).toContain('market_operator');
    user = { sub: '77', roles: ['market_operator'] };
    identitySend.mockImplementation((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'identity.user.find_by_id'
          ? { data: { id: '77', market_id: '41' } }
          : { data: [] },
      ),
    );
    await request(app.getHttpServer())
      .get('/orders/replaceable?market_id=3&customer_id=801')
      .expect(200);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '77' },
    );
    expect(orderCall('order.replaceable')).toMatchObject({
      market_id: '41',
      customer_id: '801',
    });
  });

  it('marketga biriktirilmagan operator → 400, order-service chaqirilmaydi', async () => {
    user = { sub: '78', roles: ['market_operator'] };
    identitySend.mockImplementation(() =>
      of({ data: { id: '78', market_id: null } }),
    );
    const res = await request(app.getHttpServer())
      .get('/orders/replaceable?market_id=3')
      .expect(400);
    expect(String(res.body.message)).toContain(
      'Operator hech qaysi marketga biriktirilmagan',
    );
    expect(orderSend).not.toHaveBeenCalled();
  });

  it('boshqa rollar uchun market_id majburiy → 400', async () => {
    await request(app.getHttpServer()).get('/orders/replaceable').expect(400);
    expect(orderSend).not.toHaveBeenCalled();
  });

  it('telefon qidiruvi — identity mijozlari customer_ids bilan, q uzatilmaydi', async () => {
    await request(app.getHttpServer())
      .get('/orders/replaceable?market_id=3&q=%2B998%2090%20123%2045%2067')
      .expect(200);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.customer.search' },
      expect.objectContaining({ search: '+998 90 123 45 67' }),
    );
    const payload = orderCall('order.replaceable');
    expect(payload).toMatchObject({
      market_id: '3',
      customer_ids: ['801', '802'],
    });
    expect(payload).not.toHaveProperty('q');
  });

  it('qisqa raqam — buyurtma ID (q), matn — q sifatida', async () => {
    await request(app.getHttpServer())
      .get('/orders/replaceable?market_id=3&q=123')
      .expect(200);
    expect(orderCall('order.replaceable')).toMatchObject({ q: '123' });
    expect(identitySend).not.toHaveBeenCalledWith(
      { cmd: 'identity.customer.search' },
      expect.anything(),
    );

    orderSend.mockClear();
    await request(app.getHttpServer())
      .get('/orders/replaceable?market_id=3&q=samsung')
      .expect(200);
    expect(orderCall('order.replaceable')).toMatchObject({ q: 'samsung' });
  });

  it("returns: market roli faqat o'zinikini, state uzatiladi; `:id` handleriga tushmaydi", async () => {
    user = { sub: '37', roles: ['market'] };
    await request(app.getHttpServer())
      .get('/orders/replacement/returns?state=old_collected&market_id=3')
      .expect(200);
    expect(orderCall('order.replacement.returns')).toMatchObject({
      market_id: '37',
      state: 'old_collected',
    });
    expect(orderCall('order.find_by_id')).toBeUndefined();
  });

  it('returns: superadmin market_id siz — hammasi', async () => {
    await request(app.getHttpServer())
      .get('/orders/replacement/returns')
      .expect(200);
    const payload = orderCall('order.replacement.returns');
    expect(payload).not.toHaveProperty('market_id');
  });
});
