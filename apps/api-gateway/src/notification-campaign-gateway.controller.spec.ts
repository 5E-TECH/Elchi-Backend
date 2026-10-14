import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
// RolesGuard ATAYLAB override qilinmaydi — haqiqiy rol tekshiruvi (TC9).
import { NotificationCampaignGatewayController } from './notification-campaign-gateway.controller';
import { NotificationGatewayController } from './notification-gateway.controller';

/**
 * W8aerwL6 (preview, dispatch'da mijoz maydonlari) va xHPdpj0W (kampaniya
 * navbati) — gateway marshrutlari, rollar, marshrut tartibi.
 */
describe('NotificationCampaignGatewayController — W8aerwL6 / xHPdpj0W', () => {
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
    send.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  describe('POST /notifications/audience/preview (W8aerwL6 TC8/TC9)', () => {
    it('admin → notification.audience.preview, segment bilan, 200', async () => {
      await request(http())
        .post('/notifications/audience/preview')
        .send({
          roles: ['customer'],
          include_customers: true,
          segment: { region_id: '5', min_orders: '2' },
        })
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.audience.preview' },
        {
          roles: ['customer'],
          include_customers: true,
          segment: { region_id: '5', min_orders: 2 },
        },
      ]);
    });

    it.each([['courier'], ['market'], ['registrator'], ['customer']])(
      'TC9: %s — 403 (faqat admin/superadmin)',
      async (role) => {
        user = { sub: '9', roles: [role] };
        await request(http())
          .post('/notifications/audience/preview')
          .send({ roles: ['courier'] })
          .expect(403);
        expect(send).not.toHaveBeenCalled();
      },
    );

    it('superadmin — ruxsat', async () => {
      user = { sub: '1', roles: ['superadmin'] };
      await request(http())
        .post('/notifications/audience/preview')
        .send({ broadcast: true })
        .expect(200);
    });

    it('noma’lum segment kaliti / noto‘g‘ri id — 400 (RPC chaqirilmaydi)', async () => {
      await request(http())
        .post('/notifications/audience/preview')
        .send({ include_customers: true, segment: { phones: ['+998'] } })
        .expect(400);
      await request(http())
        .post('/notifications/audience/preview')
        .send({ include_customers: true, segment: { region_id: '1 OR 1' } })
        .expect(400);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('POST /notifications/dispatch — W8aerwL6 mijoz maydonlari whitelist’da', () => {
    it('include_customers / confirm_all_customers / segment o‘tadi (avval forbidNonWhitelisted → 400)', async () => {
      await request(http())
        .post('/notifications/dispatch')
        .send({
          roles: ['customer'],
          include_customers: true,
          confirm_all_customers: false,
          segment: { market_id: '12' },
          type: 'marketing.manual',
          title: 'Promo',
        })
        .expect(201);
      expect(lastCall()?.[1]).toEqual(
        expect.objectContaining({
          include_customers: true,
          confirm_all_customers: false,
          segment: { market_id: '12' },
          requester: { id: '25', roles: ['admin'] },
        }),
      );
    });
  });

  describe('kampaniyalar (xHPdpj0W)', () => {
    it('TC2: POST /notifications/campaigns → HTTP 202, Idempotency-Key sarlavhasi va requester uzatiladi', async () => {
      send.mockReturnValueOnce(
        of({ statusCode: 202, data: { campaign_id: '7', status: 'queued' } }),
      );
      const res = await request(http())
        .post('/notifications/campaigns')
        .set('Idempotency-Key', ' camp-1 ')
        .send({
          type: 'system.manual',
          title: "E'lon",
          roles: ['courier', 'superadmin'],
          channels: ['in_app', 'push'],
          scheduled_at: '2026-10-20T09:00:00+05:00',
        })
        .expect(202);
      expect(res.body.data.campaign_id).toBe('7');
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.create' },
        expect.objectContaining({
          idempotency_key: 'camp-1',
          roles: ['courier', 'superadmin'],
          channels: ['in_app', 'push'],
          requester: { id: '25', roles: ['admin'] },
        }),
      ]);
    });

    it('SMS/telegram kanali gateway’da ham 400 (bu karta SMSni yoqmaydi)', async () => {
      for (const channel of ['sms', 'telegram', 'email']) {
        await request(http())
          .post('/notifications/campaigns')
          .set('Idempotency-Key', 'k')
          .send({
            type: 'system.manual',
            title: 't',
            roles: ['admin'],
            channels: [channel],
          })
          .expect(400);
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('marshrut tartibi: GET /notifications/campaigns → campaign.list (`:id` telegram config’ga TUSHMAYDI)', async () => {
      await request(http())
        .get('/notifications/campaigns?page=2&limit=10&status=running')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.list' },
        { page: 2, limit: 10, status: 'running' },
      ]);
    });

    it('TC4: GET /notifications/campaigns/:id → campaign.get', async () => {
      await request(http()).get('/notifications/campaigns/7').expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.get' },
        { id: '7' },
      ]);
    });

    it('TC6: POST /notifications/campaigns/:id/cancel → campaign.cancel (requester bilan)', async () => {
      await request(http())
        .post('/notifications/campaigns/7/cancel')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.cancel' },
        { id: '7', requester: { id: '25', roles: ['admin'] } },
      ]);
    });

    it('kuryer — kampaniya marshrutlari 403', async () => {
      user = { sub: '9', roles: ['courier'] };
      await request(http()).get('/notifications/campaigns').expect(403);
      await request(http())
        .post('/notifications/campaigns')
        .send({ type: 'system.manual', title: 't', roles: ['admin'] })
        .expect(403);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('api-gateway.module.ts: kampaniya controlleri NotificationGatewayController dan OLDIN', () => {
    const source = readFileSync(
      join(__dirname, 'api-gateway.module.ts'),
      'utf8',
    );
    const controllers = source.slice(source.indexOf('controllers: ['));
    const campaignAt = controllers.indexOf(
      'NotificationCampaignGatewayController,',
    );
    const notificationAt = controllers.indexOf(
      'NotificationGatewayController,',
    );
    expect(campaignAt).toBeGreaterThan(-1);
    expect(notificationAt).toBeGreaterThan(-1);
    expect(campaignAt).toBeLessThan(notificationAt);
  });
});
