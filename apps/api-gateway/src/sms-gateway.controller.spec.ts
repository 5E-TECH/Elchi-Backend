import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import {
  SmsGatewayController,
  SmsPublicGatewayController,
} from './sms-gateway.controller';
import { WebhookGatewayController } from './webhook-gateway.controller';

describe('SMS gateway routes', () => {
  let app: INestApplication;
  const send = jest.fn();
  const integrationSend = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        WebhookGatewayController,
        SmsPublicGatewayController,
        SmsGatewayController,
      ],
      providers: [
        { provide: 'NOTIFICATION', useValue: { send } },
        { provide: 'INTEGRATION', useValue: { send: integrationSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '1',
            roles: ['superadmin'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
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

  beforeEach(() => {
    send.mockReset().mockReturnValue(of({ ok: true }));
    integrationSend.mockReset().mockReturnValue(of({ ok: true }));
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  it('DLR /webhooks/sms/eskiz goes to notification (NOT the integration /webhooks/:slug)', async () => {
    const res = await request(http())
      .post('/webhooks/sms/eskiz?cmid=notif-1&token=abc')
      .send({ status: 'DELIVRD' });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'notification.sms.dlr' },
      {
        provider: 'eskiz',
        query: { cmid: 'notif-1', token: 'abc' },
        body: { status: 'DELIVRD' },
      },
    );
    expect(integrationSend).not.toHaveBeenCalled();
  });

  it('opt-out link answers with a small page; an invalid token gets 404', async () => {
    const ok = await request(http()).get('/sms/stop/998901111111.abc');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Obuna bekor qilindi');
    send.mockReturnValue(throwError(() => ({ statusCode: 404 })));
    const bad = await request(http()).get('/sms/stop/bad');
    expect(bad.status).toBe(404);
  });

  it('campaign send forwards the Idempotency-Key and the requester', async () => {
    await request(http())
      .post('/notifications/sms/campaigns')
      .set('Idempotency-Key', 'k-1')
      .send({
        message_class: 'promo',
        text: 'Chegirma',
        segment: { phones: ['+998901111111'] },
      })
      .expect(201);
    expect(send.mock.calls[0][0]).toEqual({
      cmd: 'notification.sms.campaign.send',
    });
    expect(send.mock.calls[0][1]).toMatchObject({
      idempotency_key: 'k-1',
      requester_id: '1',
    });
  });

  it('validation: unknown provider / extra fields are rejected before reaching the service', async () => {
    await request(http())
      .put('/notifications/sms/accounts')
      .send({
        provider: 'twilio',
        sender_profile: 'default',
        login: 'a',
        password: 'b',
        sender: 'X',
      })
      .expect(400);
    await request(http())
      .post('/notifications/sms/templates')
      .send({
        code: 'a.b',
        message_class: 'promo',
        lang: 'uz',
        text: 'x',
        hacker: 1,
      })
      .expect(400);
    expect(send).not.toHaveBeenCalled();
  });
});
