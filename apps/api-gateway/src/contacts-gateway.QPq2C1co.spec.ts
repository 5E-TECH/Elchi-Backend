import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ContactsGatewayController } from './contacts-gateway.controller';

/**
 * T7 (QPq2C1co) «Aloqa raqamlari» — gateway marshrutlari HAQIQIY HTTP
 * (RolesGuard + ValidationPipe), identity RMQ — mock.
 *
 * QM5: menejer `PATCH /markets/:id/responsible`, registrator
 * `GET /settings/contacts` → 403 (servis chaqirilmaydi).
 */
describe('T7 — ContactsGatewayController (HTTP)', () => {
  let app: INestApplication;
  const send: jest.Mock = jest.fn(() =>
    of({ statusCode: 200, message: 'success', data: { ok: true } }),
  );
  let roles: string[] = [];
  const fakeJwt: CanActivate = {
    canActivate: (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
      req.user = { sub: '77', roles };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ContactsGatewayController],
      providers: [{ provide: 'IDENTITY', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwt)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
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
    await app?.close();
  });

  beforeEach(() => send.mockClear());

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  it('⭐ QM5: menejer PATCH /markets/:id/responsible → 403, registrator GET /settings/contacts → 403', async () => {
    roles = ['manager'];
    await http()
      .patch('/markets/5/responsible')
      .send({ responsible_id: '1' })
      .expect(403);
    roles = ['registrator'];
    await http().get('/settings/contacts').expect(403);
    for (const role of [
      'manager',
      'registrator',
      'logist',
      'courier',
      'market',
    ]) {
      roles = [role];
      await http()
        .patch('/settings/contacts')
        .send({ support_phones: [] })
        .expect(403);
      await http().get('/markets/responsibles').expect(403);
      await http()
        .post('/markets/responsible/bulk')
        .send({ responsible_id: null, market_ids: ['1'] })
        .expect(403);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('admin: sozlamalar va mas`ullar identity`ga so`rovchi bilan boradi', async () => {
    roles = ['admin'];
    await http().get('/settings/contacts').expect(200);
    expect(send).toHaveBeenLastCalledWith(
      { cmd: 'identity.contacts.settings.get' },
      { requester: { id: '77', roles: ['admin'] } },
    );

    await http()
      .patch('/settings/contacts')
      .send({ support_phones: ['123'], default_market_responsible_id: null })
      .expect(200);
    // Telefon tarkibi identity'da tekshiriladi (SUPPORT_PHONES_INVALID kodi).
    expect(send).toHaveBeenLastCalledWith(
      { cmd: 'identity.contacts.settings.update' },
      {
        dto: { support_phones: ['123'], default_market_responsible_id: null },
        requester: { id: '77', roles: ['admin'] },
      },
    );

    await http()
      .post('/markets/responsible/bulk')
      .send({ responsible_id: '15', market_ids: ['101', '102'] })
      .expect(201);
    expect(send).toHaveBeenLastCalledWith(
      { cmd: 'identity.contacts.responsible.bulk' },
      {
        responsible_id: '15',
        market_ids: ['101', '102'],
        requester: { id: '77', roles: ['admin'] },
      },
    );

    roles = ['superadmin'];
    await http()
      .patch('/markets/101/responsible')
      .send({ responsible_id: null })
      .expect(200);
    expect(send).toHaveBeenLastCalledWith(
      { cmd: 'identity.contacts.responsible.set' },
      {
        market_id: '101',
        responsible_id: null,
        requester: { id: '77', roles: ['superadmin'] },
      },
    );
  });

  it('bulk validatsiya: bo`sh / 501 ta / responsible_id yo`q → 400', async () => {
    roles = ['admin'];
    await http()
      .post('/markets/responsible/bulk')
      .send({ responsible_id: '1', market_ids: [] })
      .expect(400);
    await http()
      .post('/markets/responsible/bulk')
      .send({
        responsible_id: '1',
        market_ids: Array.from({ length: 501 }, (_, i) => String(i + 1)),
      })
      .expect(400);
    await http()
      .post('/markets/responsible/bulk')
      .send({ market_ids: ['1'] })
      .expect(400);
    await http()
      .patch('/markets/abc/responsible')
      .send({ responsible_id: null })
      .expect(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('GET /users/me/contacts — har xodim roli (o`z id si bilan)', async () => {
    for (const role of [
      'courier',
      'manager',
      'market',
      'market_operator',
      'admin',
    ]) {
      roles = [role];
      await http().get('/users/me/contacts').expect(200);
      expect(send).toHaveBeenLastCalledWith(
        { cmd: 'identity.contacts.for_user' },
        { user_id: '77' },
      );
    }
    roles = ['customer'];
    await http().get('/users/me/contacts').expect(403);
  });
});
