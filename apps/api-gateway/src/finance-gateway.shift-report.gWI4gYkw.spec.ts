import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable, of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * y8Tqm9Ap / gWI4gYkw — gateway:
 *  - PATCH /finance/shift/settings: `auto_close` / `report` validatsiyasi,
 *    faqat superadmin;
 *  - POST /finance/shift/:id/report/resend: faqat superadmin;
 *  - GET /finance/shift/:id/report: `deliveries` va hisobot fayli havolasi
 *    faqat superadmin'ga, fayl kaliti hech kimga chiqmaydi.
 */
describe('y8Tqm9Ap / gWI4gYkw — gateway: avto-yopish sozlamalari, hisobot yuborish', () => {
  let app: INestApplication;
  type Reply = Observable<unknown>;
  const finance = { send: jest.fn((): Reply => of({})) };
  const file = { send: jest.fn((): Reply => of({})) };
  const ai = { send: jest.fn((): Reply => of({})) };
  const notification = { send: jest.fn((): Reply => of({})) };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const previousAccessKey = process.env.ACCESS_TOKEN_KEY;

  beforeAll(async () => {
    process.env.ACCESS_TOKEN_KEY = 'gWI4gYkw-spec-access-token-key';
    const module = await Test.createTestingModule({
      controllers: [FinanceGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
        { provide: 'ORDER', useValue: { send: jest.fn() } },
        { provide: 'FILE', useValue: file },
        { provide: 'AI', useValue: ai },
        { provide: 'NOTIFICATION', useValue: notification },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: unknown }>();
          const role = req.headers['x-test-role'] ?? 'registrator';
          req.user = {
            sub: role === 'manager' ? '25' : '9',
            roles: [role],
            ...(role === 'manager' ? { branch_id: '13' } : {}),
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousAccessKey === undefined) delete process.env.ACCESS_TOKEN_KEY;
    else process.env.ACCESS_TOKEN_KEY = previousAccessKey;
  });

  beforeEach(() => {
    finance.send.mockReset();
    file.send.mockReset();
    ai.send.mockReset();
    notification.send.mockReset();
  });

  const cmd = (mock: jest.Mock, name: string) =>
    (mock.mock.calls as unknown as Array<[{ cmd: string }, any]>).filter(
      ([pattern]) => pattern.cmd === name,
    );

  it('PATCH settings — auto_close / report uzatiladi; yaroqsizi 400; admin 403', async () => {
    finance.send.mockImplementation(() => of({ statusCode: 200, data: {} }));
    const denied = await request(http())
      .patch('/finance/shift/settings')
      .set('x-test-role', 'admin')
      .send({ auto_close: { enabled: true } });
    expect(denied.status).toBe(403);
    const ok = await request(http())
      .patch('/finance/shift/settings')
      .set('x-test-role', 'superadmin')
      .send({
        auto_close: {
          enabled: true,
          times: ['14:00', '23:00'],
          scope: 'main+branches',
          warn_before_min: 15,
        },
        report: {
          recipients: { couriers: { telegram: false, in_app: true } },
          format: 'xlsx',
        },
      });
    expect(ok.status).toBe(200);
    const [[, payload]] = cmd(finance.send, 'finance.shift.settings.update');
    expect(payload).toEqual(
      expect.objectContaining({
        auto_close: {
          enabled: true,
          times: ['14:00', '23:00'],
          scope: 'main+branches',
          warn_before_min: 15,
        },
        report: {
          recipients: { couriers: { telegram: false, in_app: true } },
          format: 'xlsx',
        },
        requester_roles: ['superadmin'],
      }),
    );
    for (const bad of [
      { auto_close: { times: ['25:00'] } },
      { auto_close: { scope: 'all' } },
      { auto_close: { warn_before_min: 500 } },
      { report: { format: 'csv' } },
      { report: { recipients: { couriers: { telegram: 'yes' } } } },
    ]) {
      const res = await request(http())
        .patch('/finance/shift/settings')
        .set('x-test-role', 'superadmin')
        .send(bad);
      expect(res.status).toBe(400);
    }
  });

  it('resend — faqat superadmin; rollar va smena uzatiladi', async () => {
    finance.send.mockImplementation(() =>
      of({ statusCode: 200, data: { round: 2, deliveries: [] } }),
    );
    for (const role of ['admin', 'registrator', 'manager']) {
      const res = await request(http())
        .post('/finance/shift/41/report/resend')
        .set('x-test-role', role);
      expect(res.status).toBe(403);
    }
    const bad = await request(http())
      .post('/finance/shift/abc/report/resend')
      .set('x-test-role', 'superadmin');
    expect(bad.status).toBe(400);
    const ok = await request(http())
      .post('/finance/shift/41/report/resend')
      .set('x-test-role', 'superadmin');
    expect(ok.status).toBe(201);
    expect(cmd(finance.send, 'finance.shift.report.resend')).toEqual([
      [
        { cmd: 'finance.shift.report.resend' },
        expect.objectContaining({
          shift_id: '41',
          requester_id: '9',
          requester_roles: ['superadmin'],
        }),
      ],
    ]);
  });

  it('report — deliveries va fayl havolasi faqat superadmin; kalit yashirin', async () => {
    finance.send.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          shift: { id: '41' },
          close_reason: 'auto',
          auto_close: { label: 'Avtomatik yopildi — 23:00, kassir yopmagan' },
          accounts: [],
          report: {
            status: 'sent',
            round: 1,
            file_key: 'shift-report-41.pdf',
            file_format: 'pdf',
          },
          deliveries: [
            {
              recipient_id: '502',
              recipient_kind: 'courier',
              channel: 'telegram',
              status: 'failed',
              failed_reason: 'Telegram ulanmagan',
            },
          ],
        },
      }),
    );
    const reg = await request(http()).get('/finance/shift/41/report');
    expect(reg.status).toBe(200);
    expect(reg.body.data.deliveries).toEqual([]);
    expect(reg.body.data.report).toEqual({
      status: 'sent',
      round: 1,
      file_format: 'pdf',
      has_file: true,
      file_url: null,
      file_url_expires_in: null,
    });
    expect(reg.body.data.auto_close.label).toContain('kassir yopmagan');
    const sa = await request(http())
      .get('/finance/shift/41/report')
      .set('Host', 'api.elchipochta.uz')
      .set('X-Forwarded-Proto', 'https')
      .set('x-test-role', 'superadmin');
    expect(sa.body.data.deliveries).toHaveLength(1);
    // (kiZgTybn, prod 2026-10-26) gateway havolasi — MinIO ichki manzili emas.
    expect(sa.body.data.report.file_url).toMatch(
      /^https:\/\/api\.elchipochta\.uz\/files\/signed\/[A-Za-z0-9_-]+$/,
    );
    expect(sa.body.data.report.file_url_expires_in).toBe(300);
    expect(file.send).not.toHaveBeenCalled();
    expect(sa.body.data.report.file_key).toBeUndefined();
    expect(JSON.stringify(sa.body)).not.toContain('shift-report-41.pdf');
  });

  it('report — queued yetkazishlar notification-service holati bilan sinxronlanadi; xato — fail-open', async () => {
    const dispatchId = '3f2a1b4c-5d6e-5f70-8a9b-0c1d2e3f4a5b';
    const queuedRow = {
      recipient_id: '1',
      recipient_kind: 'superadmin',
      channel: 'telegram',
      status: 'queued',
      dispatch_id: dispatchId,
    };
    finance.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'finance.shift.report'
        ? of({
            statusCode: 200,
            data: {
              shift: { id: '41' },
              accounts: [],
              deliveries: [queuedRow],
            },
          })
        : of({
            statusCode: 200,
            data: {
              updated: 1,
              deliveries: [{ ...queuedRow, status: 'sent' }],
            },
          })) as never);
    notification.send.mockImplementation(() =>
      of({
        data: [
          {
            dispatch_id: dispatchId,
            recipient_id: '1',
            delivery: { telegram: 'sent' },
          },
        ],
      }),
    );
    const sa = await request(http())
      .get('/finance/shift/41/report')
      .set('x-test-role', 'superadmin');
    expect(sa.status).toBe(200);
    expect(notification.send).toHaveBeenCalledWith(
      { cmd: 'notification.delivery.by_dispatch' },
      { dispatch_ids: [dispatchId] },
    );
    expect(
      cmd(finance.send, 'finance.shift.report.deliveries.sync')[0][1],
    ).toEqual({
      shift_id: '41',
      found: [
        {
          dispatch_id: dispatchId,
          recipient_id: '1',
          delivery: { telegram: 'sent' },
        },
      ],
    });
    expect(sa.body.data.deliveries).toEqual([
      {
        recipient_id: '1',
        recipient_kind: 'superadmin',
        channel: 'telegram',
        status: 'sent',
      },
    ]);

    // notification-service javob bermasa — finance ro'yxati (dispatch_id'siz).
    notification.send.mockImplementation(() =>
      throwError(() => new Error('down')),
    );
    const again = await request(http())
      .get('/finance/shift/41/report')
      .set('x-test-role', 'superadmin');
    expect(again.status).toBe(200);
    expect(again.body.data.deliveries).toEqual([
      {
        recipient_id: '1',
        recipient_kind: 'superadmin',
        channel: 'telegram',
        status: 'queued',
      },
    ]);
  });
});
