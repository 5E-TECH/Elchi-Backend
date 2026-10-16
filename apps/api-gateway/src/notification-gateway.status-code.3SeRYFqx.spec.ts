import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';
import { NotificationGatewayController } from './notification-gateway.controller';

/**
 * 3SeRYFqx — bildirishnoma API xatoni muvaffaqiyat sifatida QAYTARMAYDI.
 * HAQIQIY Nest routeri + global filtrlar + BodyStatusCodeInterceptor:
 * - POST /notifications/send: hammasi yiqilsa 502, qisman 207, hammasi 200;
 * - POST /notifications/connect-by-token: noto'g'ri token — 400 va tanada
 *   statusCode (avval HTTP 201 + konvertsiz { message });
 * - POST /notifications/dispatch: javobdagi unresolved o'zgarmay o'tadi.
 */
describe('NotificationGatewayController — HTTP kodi = tana statusCode (3SeRYFqx)', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationGatewayController],
      providers: [{ provide: 'NOTIFICATION', useValue: { send } }],
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
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => send.mockReset());

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  const sendResult = (statusCode: number, success: number, failed: number) => ({
    statusCode,
    message: 'Notification send result',
    data: { total: success + failed, success, failed, results: [] },
  });

  it.each([
    [502, 0, 2],
    [207, 1, 1],
    [200, 2, 0],
  ])(
    'send: tana statusCode %i (success=%i, failed=%i) → HTTP ham shu',
    async (code, success, failed) => {
      send.mockReturnValue(of(sendResult(code, success, failed)));
      const res = await request(http())
        .post('/notifications/send')
        .send({ message: 'salom', market_id: '13' });
      expect(res.status).toBe(code);
      expect(res.body.statusCode).toBe(code);
      expect(res.body.data.failed).toBe(failed);
    },
  );

  it('connect-by-token: noto‘g‘ri token → HTTP 400, tanada statusCode + message', async () => {
    send.mockReturnValue(
      throwError(() => ({
        statusCode: 400,
        message: 'Token topilmadi yoki yaroqsiz',
      })),
    );
    const res = await request(http())
      .post('/notifications/connect-by-token')
      .send({ text: 'totally-not-a-token', group_id: '-100999' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: 'Token topilmadi yoki yaroqsiz',
      }),
    );
  });

  it('connect-by-token: market topilmadi → HTTP 404; muvaffaqiyat → 201', async () => {
    send.mockReturnValueOnce(
      throwError(() => ({ statusCode: 404, message: 'Market topilmadi' })),
    );
    const missing = await request(http())
      .post('/notifications/connect-by-token')
      .send({ text: 'group_token-x', group_id: '-100999' });
    expect(missing.status).toBe(404);

    send.mockReturnValueOnce(
      of({ statusCode: 201, message: 'ulandi', data: { id: '41' } }),
    );
    const ok = await request(http())
      .post('/notifications/connect-by-token')
      .send({ text: 'group_token-x', group_id: '-100999' });
    expect(ok.status).toBe(201);
  });

  it('dispatch: unresolved ro‘yxati javobda o‘zgarmay qaytadi; hammasi topilmasa — 400', async () => {
    send.mockReturnValueOnce(
      of({
        statusCode: 201,
        message: 'Notification dispatched',
        data: {
          dispatched: 1,
          recipient_ids: ['42'],
          unresolved: ['99999999'],
        },
      }),
    );
    const mixed = await request(http())
      .post('/notifications/dispatch')
      .send({
        recipient_ids: ['42', '99999999'],
        type: 'system.manual',
        title: 'x',
      });
    expect(mixed.status).toBe(201);
    expect(mixed.body.data.unresolved).toEqual(['99999999']);

    send.mockReturnValueOnce(
      throwError(() => ({
        statusCode: 400,
        message: 'Qabul qiluvchi topilmadi: 99999999',
      })),
    );
    const none = await request(http())
      .post('/notifications/dispatch')
      .send({ recipient_id: '99999999', type: 'system.manual', title: 'x' });
    expect(none.status).toBe(400);
    expect(none.body.statusCode).toBe(400);
  });

  it('kontrakt: interceptor POST send / connect-by-token / dispatch / create marshrutlarida', () => {
    const proto = NotificationGatewayController.prototype as unknown as Record<
      string,
      object
    >;
    for (const method of [
      'sendNotification',
      'connectByToken',
      'dispatch',
      'createNotification',
    ]) {
      const interceptors =
        (Reflect.getMetadata('__interceptors__', proto[method]) as
          | unknown[]
          | undefined) ?? [];
      expect(interceptors).toContain(BodyStatusCodeInterceptor);
    }
  });
});
