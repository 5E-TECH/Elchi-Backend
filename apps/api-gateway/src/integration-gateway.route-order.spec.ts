import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { IntegrationGatewayController } from './integration-gateway.controller';

/**
 * MARSHRUT TARTIBI — statik segment `:id` dan OLDIN turishi SHART.
 *
 * ⚠️ ILGARI `@Get(':id')` `@Get('receivables')` dan YUQORIDA e'lon qilingandi.
 * NestJS marshrutni e'lon tartibida moslagani uchun
 * `GET /integrations/receivables` so'rovi `findById`ga `id='receivables'`
 * bilan tushardi — provayder COD debitorligi endpointi HECH QACHON
 * chaqirilmasdi.
 *
 * Bu test grep bilan emas, HAQIQIY Nest routeri orqali tekshiradi: qaysi
 * `cmd` quyi servisga ketganiga qaraymiz.
 */
describe('IntegrationGatewayController — marshrut tartibi', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IntegrationGatewayController],
      providers: [{ provide: 'INTEGRATION', useValue: { send } }],
    })
      // Auth bu yerda sinalmaydi — tekshirilayotgani marshrut tanlovi.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    send.mockReset();
    send.mockReturnValue(of({ data: [] }));
  });

  const cmdOf = () => send.mock.calls.at(-1)?.[0]?.cmd;

  it("TC1: /integrations/receivables -> `:id` ga TUSHMAYDI", async () => {
    const res = await request(app.getHttpServer()).get(
      '/integrations/receivables',
    );

    expect(res.status).toBe(200);
    expect(cmdOf()).toBe('integration.receivable.list');
    // Aynan shu yerda eski xato ushlanadi:
    expect(cmdOf()).not.toBe('integration.find_by_id');
  });

  it('TC2: /integrations/shipments/:order_id -> shipment.get', async () => {
    send.mockReturnValue(of({ data: null }));

    const res = await request(app.getHttpServer()).get(
      '/integrations/shipments/5',
    );

    expect(res.status).toBe(200);
    expect(cmdOf()).toBe('integration.shipment.get');
    expect(send.mock.calls.at(-1)?.[1]).toEqual({ order_id: '5' });
  });

  it("TC3: haqiqiy raqamli id hamon `:id` ga boradi (regressiya emas)", async () => {
    const res = await request(app.getHttpServer()).get('/integrations/42');

    expect(res.status).toBe(200);
    expect(cmdOf()).toBe('integration.find_by_id');
    expect(send.mock.calls.at(-1)?.[1]).toEqual({ id: '42' });
  });

  it('TC4: `:id/shipments` hamon ishlaydi (tartib buzilmadi)', async () => {
    await request(app.getHttpServer()).get('/integrations/42/shipments');

    expect(cmdOf()).toBe('integration.shipment.list');
  });

  it('TC5: `:id/receivable-balance` hamon ishlaydi', async () => {
    await request(app.getHttpServer()).get(
      '/integrations/42/receivable-balance',
    );

    expect(cmdOf()).toBe('integration.receivable.balance');
  });
});

/**
 * ID SHAKLI — noto'g'ri id 500 emas, 400 qaytarishi kerak.
 *
 * ⚠️ Id `bigint` (BaseEntity), UUID EMAS. Tekshiruvsiz `GET /integrations/abc`
 * quyi servisda Postgres'ning `invalid input syntax for type bigint` xatosiga
 * aylanib, mijozga 500 (server xatosi) qaytarardi — aslida bu 400.
 */
describe('IntegrationGatewayController — id shakli', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IntegrationGatewayController],
      providers: [{ provide: 'INTEGRATION', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    send.mockReset();
    send.mockReturnValue(of({ data: null }));
  });

  it('TC6: harfli id -> 400, quyi servisga UMUMAN bormaydi', async () => {
    const res = await request(app.getHttpServer()).get('/integrations/abc');

    expect(res.status).toBe(400);
    // Eng muhimi: yaroqsiz qiymat bilan RPC yuborilmadi.
    expect(send).not.toHaveBeenCalled();
  });

  it('TC7: SQL-ga o‘xshash id ham 400', async () => {
    const res = await request(app.getHttpServer()).get(
      "/integrations/1' OR '1'='1",
    );

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('TC8: raqamli id 400 BERMAYDI (yolg‘on ijobiy yo‘q)', async () => {
    const res = await request(app.getHttpServer()).get('/integrations/7');

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalled();
  });
});
