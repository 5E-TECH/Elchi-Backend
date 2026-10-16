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
import { JwtAuthGuard } from './auth/jwt-auth.guard';
// RolesGuard ATAYLAB override qilinmaydi — haqiqiy rol tekshiruvi.
import { NotificationCampaignGatewayController } from './notification-campaign-gateway.controller';
import { NotificationGatewayController } from './notification-gateway.controller';
import { SmsGatewayController } from './sms-gateway.controller';

/**
 * WIsb9Ytq (rejalashtirish qoidasi, ro'yxat holati, zonali vaqt) va
 * H7kpCman (kampaniya hisoboti, yetkazilmaganlar, CSV eksport — faqat
 * superadmin, ≤10 000 fayl / kattasi 202) — gateway marshrutlari.
 */
describe('Kampaniya rejalashtirish / hisobot gateway — WIsb9Ytq, H7kpCman', () => {
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
        SmsGatewayController,
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
  const superadmin = () => {
    user = { sub: '26', roles: ['superadmin'] };
  };

  beforeEach(() => {
    user = { sub: '25', roles: ['admin'] };
    send.mockReset();
    send.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  describe('WIsb9Ytq', () => {
    it('GET /notifications/campaigns/schedule-policy → schedule_policy (`:id` ga TUSHMAYDI)', async () => {
      await request(http())
        .get('/notifications/campaigns/schedule-policy')
        .query({
          scheduled_at: '2026-10-20T19:30:00+05:00',
          type: 'marketing.manual',
        })
        .expect(200);
      expect(lastCall()?.[0]).toEqual({
        cmd: 'notification.campaign.schedule_policy',
      });
      expect(lastCall()?.[1]).toEqual({
        scheduled_at: '2026-10-20T19:30:00+05:00',
        type: 'marketing.manual',
      });
    });

    it('scheduled_at zonasiz — 400 (create va schedule-policy), RPC chaqirilmaydi', async () => {
      await request(http())
        .post('/notifications/campaigns')
        .set('Idempotency-Key', 'k-1')
        .send({
          type: 'marketing.manual',
          title: 'Aksiya',
          roles: ['courier'],
          scheduled_at: '2026-10-20T19:30:00',
        })
        .expect(400);
      await request(http())
        .get('/notifications/campaigns/schedule-policy')
        .query({ scheduled_at: '2026-10-20T19:30' })
        .expect(400);
      expect(send).not.toHaveBeenCalled();

      send.mockReturnValueOnce(of({ statusCode: 202, data: {} }));
      await request(http())
        .post('/notifications/campaigns')
        .set('Idempotency-Key', 'k-2')
        .send({
          type: 'marketing.manual',
          title: 'Aksiya',
          roles: ['courier'],
          scheduled_at: '2026-10-20T19:30:00+05:00',
        })
        .expect(202);
      expect(lastCall()?.[1]).toEqual(
        expect.objectContaining({ scheduled_at: '2026-10-20T19:30:00+05:00' }),
      );
    });

    it('GET /notifications/campaigns?state=scheduled → campaign.list (state uzatiladi); noma’lum state — 400', async () => {
      await request(http())
        .get('/notifications/campaigns')
        .query({ state: 'scheduled' })
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.list' },
        { state: 'scheduled' },
      ]);
      await request(http())
        .get('/notifications/campaigns')
        .query({ state: 'paused' })
        .expect(400);
    });
  });

  describe('H7kpCman — bildirishnoma kampaniyasi', () => {
    it('GET /notifications/campaigns/:id/report → report (kind=notification, requester)', async () => {
      await request(http())
        .get('/notifications/campaigns/7/report')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.report' },
        {
          kind: 'notification',
          id: '7',
          requester: { id: '25', roles: ['admin'] },
        },
      ]);
    });

    it('GET /notifications/campaigns/:id/undelivered → undelivered (sahifa)', async () => {
      await request(http())
        .get('/notifications/campaigns/7/undelivered')
        .query({ page: 2, limit: 50 })
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.undelivered' },
        { kind: 'notification', id: '7', page: 2, limit: 50 },
      ]);
      await request(http())
        .get('/notifications/campaigns/7/undelivered')
        .query({ limit: 500 })
        .expect(400);
    });

    it('TC7: CSV eksport — admin 403 (RPC yo‘q)', async () => {
      await request(http())
        .get('/notifications/campaigns/7/undelivered/export')
        .expect(403);
      await request(http())
        .get('/notifications/campaigns/exports/5/download')
        .expect(403);
      expect(send).not.toHaveBeenCalled();
    });

    it('TC8: superadmin, ≤10 000 — 200 text/csv fayl (Content-Disposition, X-Export-Total)', async () => {
      superadmin();
      send.mockReturnValueOnce(
        of({
          statusCode: 200,
          data: {
            mode: 'sync',
            rows: 2,
            filename: 'kampaniya-notification-7-yetkazilmaganlar.csv',
            content_type: 'text/csv; charset=utf-8',
            csv: 'recipient_id\r\n42\r\n43\r\n',
          },
        }),
      );
      const res = await request(http())
        .get('/notifications/campaigns/7/undelivered/export')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kampaniya-notification-7-yetkazilmaganlar.csv"',
      );
      expect(res.headers['x-export-total']).toBe('2');
      expect(res.text).toBe('recipient_id\r\n42\r\n43\r\n');
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.export' },
        {
          kind: 'notification',
          id: '7',
          requester: { id: '26', roles: ['superadmin'] },
        },
      ]);
    });

    it('TC9: 10 000+ — 202 JSON { export_id } (sinxron fayl emas); holat va yuklab olish', async () => {
      superadmin();
      send.mockReturnValueOnce(
        of({
          statusCode: 202,
          data: { mode: 'async', export_id: '5', status: 'queued' },
        }),
      );
      const queued = await request(http())
        .get('/notifications/campaigns/7/undelivered/export')
        .expect(202);
      expect(queued.body.data).toEqual(
        expect.objectContaining({ export_id: '5', status: 'queued' }),
      );

      await request(http())
        .get('/notifications/campaigns/exports/5')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.export.get' },
        { export_id: '5', requester: { id: '26', roles: ['superadmin'] } },
      ]);

      send.mockReturnValueOnce(
        of({
          statusCode: 200,
          data: { mode: 'file', rows: 12000, filename: 'k.csv', csv: 'x' },
        }),
      );
      const file = await request(http())
        .get('/notifications/campaigns/exports/5/download')
        .expect(200);
      expect(file.headers['content-disposition']).toBe(
        'attachment; filename="k.csv"',
      );
      expect(lastCall()?.[0]).toEqual({
        cmd: 'notification.campaign.export.download',
      });
    });
  });

  describe('H7kpCman — SMS kampaniyasi', () => {
    it('report / undelivered — kind=sms', async () => {
      await request(http())
        .get('/notifications/sms/campaigns/9/report')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.report' },
        {
          kind: 'sms',
          id: '9',
          requester: { id: '25', roles: ['admin'] },
        },
      ]);
      await request(http())
        .get('/notifications/sms/campaigns/9/undelivered')
        .expect(200);
      expect(lastCall()).toEqual([
        { cmd: 'notification.campaign.undelivered' },
        { kind: 'sms', id: '9' },
      ]);
    });

    it('CSV — faqat superadmin', async () => {
      await request(http())
        .get('/notifications/sms/campaigns/9/undelivered/export')
        .expect(403);
      superadmin();
      send.mockReturnValueOnce(
        of({
          statusCode: 200,
          data: { mode: 'sync', rows: 1, filename: 's.csv', csv: 'a' },
        }),
      );
      await request(http())
        .get('/notifications/sms/campaigns/9/undelivered/export')
        .expect(200);
      expect(lastCall()?.[1]).toEqual(
        expect.objectContaining({ kind: 'sms', id: '9' }),
      );
    });
  });
});
