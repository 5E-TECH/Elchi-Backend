import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { SmsGatewayController } from './sms-gateway.controller';

/**
 * nkhURiKX #6 — muharrir hisoblagichi uchun backend endpointi:
 * POST /notifications/sms/templates/preview (hech narsa yozilmaydi).
 */
describe('SMS template preview route (nkhURiKX)', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SmsGatewayController],
      providers: [{ provide: 'NOTIFICATION', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '1',
            roles: ['admin'],
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
    send.mockReset().mockReturnValue(of({ parts: 1, encoding: 'UCS-2' }));
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  it('forwards text/class/vars to notification.sms.templates.preview and answers 200', async () => {
    const body = {
      text: 'Заказ #{{order_number}} доставлен',
      message_class: 'transactional',
      required_vars: ['order_number'],
      vars: { order_number: 'EL-1042' },
    };
    const res = await request(http())
      .post('/notifications/sms/templates/preview')
      .send(body)
      .expect(200);
    expect(res.body).toEqual({ parts: 1, encoding: 'UCS-2' });
    expect(send).toHaveBeenCalledWith(
      { cmd: 'notification.sms.templates.preview' },
      body,
    );
  });

  it('an empty editor text is allowed (0 parts) — the counter starts at zero', async () => {
    await request(http())
      .post('/notifications/sms/templates/preview')
      .send({ text: '' })
      .expect(200);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'notification.sms.templates.preview' },
      { text: '' },
    );
  });

  it('validation: unknown class, >1000 chars, non-object vars, extra fields → 400 before the service', async () => {
    for (const body of [
      { text: 'x', message_class: 'spam' },
      { text: 'a'.repeat(1001) },
      { text: 'x', vars: 'order_number' },
      { text: 'x', lang: 'ru' },
      {},
    ]) {
      await request(http())
        .post('/notifications/sms/templates/preview')
        .send(body)
        .expect(400);
    }
    expect(send).not.toHaveBeenCalled();
  });
});
