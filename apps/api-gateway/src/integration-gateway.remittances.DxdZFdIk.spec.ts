import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { IntegrationGatewayController } from './integration-gateway.controller';

/**
 * DxdZFdIk — kargo to'lovlari ro'yxati (GET) va bekor qilish (POST
 * .../cancel). Haqiqiy Nest routeri + ValidationPipe (whitelist,
 * forbidNonWhitelisted — main.ts dagi kabi).
 */
describe('IntegrationGatewayController — remittances (DxdZFdIk)', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IntegrationGatewayController],
      providers: [{ provide: 'INTEGRATION', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().user = {
            sub: '9',
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

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  type RpcCall = [{ cmd: string }, Record<string, unknown>];
  const lastCall = () => send.mock.calls.at(-1) as RpcCall | undefined;

  beforeEach(() => {
    send.mockReset();
    send.mockReturnValue(of({ statusCode: 200, data: { items: [] } }));
  });

  it('GET /integrations/:id/remittances — find_all, sana va sahifalash uzatiladi', async () => {
    const res = await request(http()).get(
      '/integrations/2/remittances?from_date=2026-10-01&to_date=2026-10-14&page=2&limit=10&status=active',
    );

    expect(res.status).toBe(200);
    expect(lastCall()?.[0].cmd).toBe('integration.remittance.find_all');
    expect(lastCall()?.[1]).toEqual({
      integration_id: '2',
      status: 'active',
      from_date: '2026-10-01',
      to_date: '2026-10-14',
      page: 2,
      limit: 10,
    });
  });

  it('GET — fromDate/toDate (camelCase) ham qabul qilinadi', async () => {
    await request(http()).get(
      '/integrations/2/remittances?fromDate=2026-10-01&toDate=2026-10-02',
    );

    expect(lastCall()?.[1]).toMatchObject({
      from_date: '2026-10-01',
      to_date: '2026-10-02',
    });
  });

  it('POST /integrations/:id/remittances/:rid/cancel — 200, sabab va kim bekor qilgani uzatiladi', async () => {
    const res = await request(http())
      .post('/integrations/2/remittances/77/cancel')
      .send({ reason: 'Summa xato', reverse_cashbox: true });

    expect(res.status).toBe(200);
    expect(lastCall()?.[0].cmd).toBe('integration.remittance.cancel');
    expect(lastCall()?.[1]).toEqual({
      integration_id: '2',
      remittance_id: '77',
      reason: 'Summa xato',
      reverse_cashbox: true,
      cancelled_by: '9',
    });
  });

  it('POST cancel — bo`sh body ham bo`ladi (reverse_cashbox null)', async () => {
    const res = await request(http())
      .post('/integrations/2/remittances/77/cancel')
      .send({});

    expect(res.status).toBe(200);
    expect(lastCall()?.[1]).toMatchObject({
      reason: null,
      reverse_cashbox: null,
    });
  });

  it('POST cancel — noma`lum maydon yoki raqam bo`lmagan id → 400, RPC yo`q', async () => {
    const unknownField = await request(http())
      .post('/integrations/2/remittances/77/cancel')
      .send({ amount: 5 });
    const badId = await request(http())
      .post('/integrations/2/remittances/abc/cancel')
      .send({});

    expect(unknownField.status).toBe(400);
    expect(badId.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
