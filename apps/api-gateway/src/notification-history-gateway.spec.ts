import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateAdminRequestDto } from './dto/identity.swagger.dto';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
// RolesGuard ATAYLAB override qilinmaydi — haqiqiy rol tekshiruvi.
import { NotificationCampaignGatewayController } from './notification-campaign-gateway.controller';
import { NotificationGatewayController } from './notification-gateway.controller';

/**
 * 7Vozou5x — yuborilgan xabarlar tarixi marshrutlari (`/notifications/sent`)
 * va dispatch'dagi `client_request_id`. Faqat SUPERADMIN/ADMIN (TC12).
 */
describe('Gateway — /notifications/sent (7Vozou5x)', () => {
  let app: INestApplication;
  const send = jest.fn();
  let user: { sub: string; roles: string[] } = {
    sub: '25',
    roles: ['admin'],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // api-gateway.module.ts dagi tartib bilan bir xil.
      controllers: [
        NotificationCampaignGatewayController,
        NotificationGatewayController,
      ],
      providers: [{ provide: 'NOTIFICATION', useValue: { send } }, Reflector],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
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
  type RpcCall = [{ cmd: string }, Record<string, unknown>];
  const lastCall = () => send.mock.calls.at(-1) as RpcCall | undefined;

  beforeEach(() => {
    user = { sub: '25', roles: ['admin'] };
    send.mockReset();
    // (3SeRYFqx) dispatch: HTTP kod = tana statusCode (haqiqatda 201).
    send.mockReturnValue(of({ statusCode: 201, data: {} }));
  });

  it('GET /notifications/sent → dispatch_history.list (`:id` telegram config’ga TUSHMAYDI)', async () => {
    await request(http())
      .get('/notifications/sent?page=2&limit=10&status=partial')
      .expect(200);
    expect(lastCall()).toEqual([
      { cmd: 'notification.dispatch_history.list' },
      { page: 2, limit: 10, status: 'partial' },
    ]);
  });

  it('GET /notifications/sent/:dispatch_id → dispatch_history.get (sahifa bilan)', async () => {
    await request(http())
      .get('/notifications/sent/7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d?page=1')
      .expect(200);
    expect(lastCall()).toEqual([
      { cmd: 'notification.dispatch_history.get' },
      { page: 1, dispatch_id: '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
    ]);
  });

  it('noto‘g‘ri status / limit — 400 (RPC chaqirilmaydi)', async () => {
    await request(http()).get('/notifications/sent?status=done').expect(400);
    await request(http()).get('/notifications/sent?limit=1000').expect(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('TC12: superadmin ochadi; kuryer/market/registrator — 403', async () => {
    user = { sub: '1', roles: ['superadmin'] };
    await request(http()).get('/notifications/sent').expect(200);
    for (const role of ['courier', 'market', 'registrator']) {
      user = { sub: '9', roles: [role] };
      await request(http()).get('/notifications/sent').expect(403);
      await request(http()).get('/notifications/sent/abc').expect(403);
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe('rCFZAmOz — shaxsiy Telegram', () => {
    it('POST /notifications/telegram/link — istalgan rol, user_id FAQAT JWT’dan', async () => {
      user = { sub: '9', roles: ['courier'] };
      await request(http()).post('/notifications/telegram/link').expect(201);
      expect(lastCall()).toEqual([
        { cmd: 'notification.telegram.link_token' },
        expect.objectContaining({ user_id: '9', roles: ['courier'] }),
      ]);
      // Body'dagi begona user_id qabul qilinmaydi (whitelist yo'q DTO — e'tiborsiz).
      await request(http())
        .post('/notifications/telegram/link')
        .send({ user_id: '1' })
        .expect(201);
      expect(lastCall()?.[1]).toEqual(
        expect.objectContaining({ user_id: '9' }),
      );
    });

    it('POST /notifications/telegram/broadcast — admin: dispatch (system.manual, in_app + telegram, requester)', async () => {
      await request(http())
        .post('/notifications/telegram/broadcast')
        .send({ title: 'E’lon', body: 'Matn', roles: ['courier'] })
        .expect(201);
      expect(lastCall()).toEqual([
        { cmd: 'notification.dispatch' },
        {
          title: 'E’lon',
          body: 'Matn',
          roles: ['courier'],
          type: 'system.manual',
          channels: ['in_app', 'telegram'],
          requester: { id: '25', roles: ['admin'] },
        },
      ]);
    });

    it('broadcast — kuryer 403; `type`/`channels` ni almashtirib bo‘lmaydi (400)', async () => {
      user = { sub: '9', roles: ['courier'] };
      await request(http())
        .post('/notifications/telegram/broadcast')
        .send({ title: 'x', broadcast: true })
        .expect(403);
      user = { sub: '25', roles: ['admin'] };
      await request(http())
        .post('/notifications/telegram/broadcast')
        .send({ title: 'x', broadcast: true, channels: ['sms'] })
        .expect(400);
      await request(http())
        .post('/notifications/telegram/broadcast')
        .send({ title: 'x', broadcast: true, type: 'order.sold' })
        .expect(400);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('C4R3YyvH — shablonlar', () => {
    it('GET /notifications/templates → templates.list (`:id` telegram config’ga tushmaydi)', async () => {
      await request(http())
        .get('/notifications/templates?code=order.sold&lang=ru')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.templates.list' },
        { code: 'order.sold', lang: 'ru' },
      ]);
    });

    it('PUT /notifications/templates → templates.upsert (requester bilan); noto‘g‘ri til/kanal 400', async () => {
      await request(http())
        .put('/notifications/templates')
        .send({
          code: 'order.sold',
          lang: 'ru',
          channel: null,
          title: 'Продан',
          body: 'Заказ #{{order_number}} продан',
          required_vars: ['order_number'],
        })
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.templates.upsert' },
        {
          code: 'order.sold',
          lang: 'ru',
          channel: null,
          title: 'Продан',
          body: 'Заказ #{{order_number}} продан',
          required_vars: ['order_number'],
          requester: { id: '25', roles: ['admin'] },
        },
      ]);
      send.mockClear();
      await request(http())
        .put('/notifications/templates')
        .send({ code: 'order.sold', lang: 'de', title: 't' })
        .expect(400);
      await request(http())
        .put('/notifications/templates')
        .send({ code: 'order.sold', lang: 'uz', channel: 'fax', title: 't' })
        .expect(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('TC12: GET/PUT /notifications/templates — faqat superadmin/admin (kuryer/market 403)', async () => {
      for (const role of ['courier', 'market', 'registrator']) {
        user = { sub: '9', roles: [role] };
        await request(http()).get('/notifications/templates').expect(403);
        await request(http())
          .put('/notifications/templates')
          .send({ code: 'order.sold', lang: 'uz', title: 't' })
          .expect(403);
      }
      user = { sub: '1', roles: ['superadmin'] };
      await request(http()).get('/notifications/templates').expect(200);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('TC16: PATCH /auth/my-profile DTO — language uz/ru/en qabul qilinadi, boshqasi rad', async () => {
      expect(
        await validate(
          plainToInstance(UpdateAdminRequestDto, { language: 'ru' }),
        ),
      ).toHaveLength(0);
      const errors = await validate(
        plainToInstance(UpdateAdminRequestDto, { language: 'kk' }),
      );
      expect(errors.map((e) => e.property)).toEqual(['language']);
    });
  });

  describe('ebSV5oyP — auditoriya konstruktori', () => {
    it('preview: with_sample / audience_segment_id / max_orders uzatiladi', async () => {
      await request(http())
        .post('/notifications/audience/preview')
        .send({
          include_customers: true,
          segment: { region_id: '5', min_orders: 3, max_orders: 10 },
          with_sample: true,
        })
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.audience.preview' },
        {
          include_customers: true,
          segment: { region_id: '5', min_orders: 3, max_orders: 10 },
          with_sample: true,
        },
      ]);
      await request(http())
        .post('/notifications/audience/preview')
        .send({ audience_segment_id: '3' })
        .expect(200);
      expect(lastCall()?.[1]).toEqual({ audience_segment_id: '3' });
    });

    it('preview: max_orders 0 / noto‘g‘ri sana — 400 (RPC yo‘q)', async () => {
      await request(http())
        .post('/notifications/audience/preview')
        .send({ include_customers: true, segment: { max_orders: 0 } })
        .expect(400);
      await request(http())
        .post('/notifications/audience/preview')
        .send({ include_customers: true, segment: { last_order_to: 'kecha' } })
        .expect(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('segmentlar: GET/POST/DELETE → RMQ (requester bilan); nomsiz 400', async () => {
      await request(http()).get('/notifications/audience/segments').expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.audience.segments.list' },
        {},
      ]);
      await request(http())
        .post('/notifications/audience/segments')
        .send({
          name: 'Faol mijozlar',
          include_customers: true,
          segment: { region_id: '5' },
        })
        .expect(201);
      expect(lastCall()).toEqual([
        { cmd: 'notification.audience.segments.create' },
        {
          name: 'Faol mijozlar',
          include_customers: true,
          segment: { region_id: '5' },
          requester: { id: '25', roles: ['admin'] },
        },
      ]);
      await request(http())
        .delete('/notifications/audience/segments/3')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.audience.segments.delete' },
        { id: '3' },
      ]);
      send.mockClear();
      await request(http())
        .post('/notifications/audience/segments')
        .send({ name: '   ', roles: ['courier'] })
        .expect(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('TC9: segment marshrutlari faqat superadmin/admin', async () => {
      user = { sub: '9', roles: ['market'] };
      await request(http()).get('/notifications/audience/segments').expect(403);
      await request(http())
        .post('/notifications/audience/segments')
        .send({ name: 'x', roles: ['courier'] })
        .expect(403);
      await request(http())
        .delete('/notifications/audience/segments/3')
        .expect(403);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('POST /notifications/dispatch — client_request_id (UUID) uzatiladi; UUID bo‘lmasa 400', async () => {
    await request(http())
      .post('/notifications/dispatch')
      .send({
        type: 'system.manual',
        title: 'E’lon',
        roles: ['courier'],
        client_request_id: '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      })
      .expect(201);
    expect(lastCall()?.[1]).toMatchObject({
      client_request_id: '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      requester: { id: '25', roles: ['admin'] },
    });
    send.mockClear();
    await request(http())
      .post('/notifications/dispatch')
      .send({
        type: 'system.manual',
        title: 'E’lon',
        roles: ['courier'],
        client_request_id: 'dispatch',
      })
      .expect(400);
    expect(send).not.toHaveBeenCalled();
  });
});
