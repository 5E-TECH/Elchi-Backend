import 'reflect-metadata';
import {
  ExecutionContext,
  GatewayTimeoutException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { OrderGatewayController } from './order-gateway.controller';
import { scanOrderSummary } from './order-scan-summary';
import { TelegramGatewayController } from './telegram-gateway.controller';

/**
 * MWYaqprw (backend qismi) — skan Mini App'i:
 *  - `POST /telegram/scan/done`: faqat kuryer, kuryer id JWT'dan;
 *  - `POST /orders/scan-assign` javobida `data.order` (tuman, mijoz) —
 *    qidiruv yiqilsa skan javobi o'zgarmaydi.
 */
describe('MWYaqprw — POST /telegram/scan/done', () => {
  let app: INestApplication;
  const notificationSend = jest.fn();
  let user: { sub: string; roles: string[] } | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelegramGatewayController],
      providers: [
        { provide: 'NOTIFICATION', useValue: { send: notificationSend } },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!user) return false;
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            ...user,
          };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeEach(() => {
    user = { sub: '26', roles: ['courier'] };
    notificationSend
      .mockReset()
      .mockReturnValue(of({ statusCode: 200, data: { accepted: 2 } }));
  });

  it('⭐ kuryer id JWT’dan; tanadagi courier_id qabul qilinmaydi (400)', async () => {
    await request(http())
      .post('/telegram/scan/done')
      .send({ order_ids: ['53', '54'] })
      .expect(201);
    expect(notificationSend).toHaveBeenCalledWith(
      { cmd: 'notification.telegram.scan_done' },
      { courier_id: '26', order_ids: ['53', '54'] },
    );
    await request(http())
      .post('/telegram/scan/done')
      .send({ order_ids: ['53'], courier_id: '99' })
      .expect(400);
  });

  it('faqat kuryer: market → 403', async () => {
    user = { sub: '37', roles: ['market'] };
    await request(http())
      .post('/telegram/scan/done')
      .send({ order_ids: ['53'] })
      .expect(403);
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it('id’lar: bo‘sh, raqam emas yoki 200 dan ko‘p → 400', async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => String(i + 1));
    for (const order_ids of [[], ['abc'], tooMany]) {
      await request(http())
        .post('/telegram/scan/done')
        .send({ order_ids })
        .expect(400);
    }
    expect(notificationSend).not.toHaveBeenCalled();
  });
});

describe('MWYaqprw — scan-assign javobida buyurtma xulosasi', () => {
  const LIGHT = {
    statusCode: 200,
    data: {
      id: '53',
      order_number: 'EL-100053',
      status: 'on the road',
      total_price: '10000.00',
      address: "Navoiy ko'chasi 1",
      courier_tariff: 5000,
      market: { id: '37', name: 'TEST Market' },
      customer: {
        id: '51',
        name: 'TEST Mijoz',
        phone_number: '+998887009299',
        address: 'x',
      },
      district: { id: '173', name: 'Andijon shahri' },
      region: { id: '3', name: 'Andijon' },
      special_categories: ['fragile', 'religious_book'],
    },
  };

  it('⭐ scanOrderSummary: tuman/mijoz/market nomlari; tarif kabi maydonlar KIRMAYDI', () => {
    expect(scanOrderSummary(LIGHT)).toEqual({
      id: '53',
      order_number: 'EL-100053',
      status: 'on the road',
      total_price: 10000,
      address: "Navoiy ko'chasi 1",
      district: 'Andijon shahri',
      region: 'Andijon',
      market: 'TEST Market',
      customer: { name: 'TEST Mijoz', phone_number: '+998887009299' },
      // T8: «O'zimga olish» kartasida maxsus belgilar.
      special_categories: ['fragile', 'religious_book'],
    });
    expect(scanOrderSummary({ data: { id: '1' } })?.special_categories).toEqual(
      [],
    );
    expect(scanOrderSummary({ data: { foo: 1 } })).toBeNull();
  });

  const controller = (sendOrder: jest.Mock, sendLogistics: jest.Mock) => {
    const self = Object.create(OrderGatewayController.prototype) as Record<
      string,
      unknown
    >;
    self.sendOrderWithTimeout = sendOrder;
    self.sendLogisticsWithTimeout = sendLogistics;
    self.normalizeRoles = (roles: string[]) => roles;
    self.logger = { warn: jest.fn() };
    return self as unknown as OrderGatewayController;
  };
  const req = { user: { sub: '26', roles: ['courier'] } } as never;
  const assigned = {
    statusCode: 200,
    message: 'Order courierga biriktirildi',
    data: { idempotent: false, order_id: '53', post_id: '25' },
  };

  it('⭐ muvaffaqiyatli skan → data.order (light qidiruv o‘sha token bilan)', async () => {
    const sendOrder = jest.fn().mockResolvedValue(LIGHT);
    const sendLogistics = jest.fn().mockResolvedValue(assigned);
    const res = (await controller(sendOrder, sendLogistics).scanAssignOrder(
      { qr_token: 'tok-53' },
      req,
    )) as { data: Record<string, unknown> };
    expect(sendOrder).toHaveBeenCalledWith(
      { cmd: 'order.find_by_qr_light' },
      { token: 'tok-53' },
    );
    expect(res.data).toEqual(
      expect.objectContaining({
        order_id: '53',
        post_id: '25',
        order: expect.objectContaining({
          district: 'Andijon shahri',
          customer: { name: 'TEST Mijoz', phone_number: '+998887009299' },
        }),
      }),
    );
  });

  it('qidiruv kechiksa/yiqilsa — skan javobi o‘zgarishsiz (biriktirish allaqachon bo‘lgan)', async () => {
    const sendOrder = jest
      .fn()
      .mockRejectedValue(new GatewayTimeoutException('timeout'));
    const sendLogistics = jest.fn().mockResolvedValue(assigned);
    const res = await controller(sendOrder, sendLogistics).scanAssignOrder(
      { qr_token: 'tok-53' },
      req,
    );
    expect(res).toEqual(assigned);
  });

  it('skan xatosi (boshqa kuryerniki) — o‘zgarishsiz uzatiladi, qidiruv qilinmaydi', async () => {
    const sendOrder = jest.fn();
    const error = {
      statusCode: 400,
      message: 'Order allaqachon boshqa courierga biriktirilgan',
    };
    const sendLogistics = jest.fn().mockRejectedValue(error);
    await expect(
      controller(sendOrder, sendLogistics).scanAssignOrder(
        { qr_token: 'tok-1' },
        req,
      ),
    ).rejects.toBe(error);
    expect(sendOrder).not.toHaveBeenCalled();
  });
});
