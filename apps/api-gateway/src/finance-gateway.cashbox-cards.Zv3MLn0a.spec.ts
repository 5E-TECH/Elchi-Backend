import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { FinanceGatewayController } from './finance-gateway.controller';
import {
  PaymentBranchToMainRequestDto,
  PaymentFromCourierRequestDto,
} from './dto/finance.swagger.dto';

/**
 * Zv3MLn0a — kassa kartalari / hisob raqamlari gateway kontrakti: tafsilotlar
 * (last4 FAQAT 4 raqam), smena sozlamalari faqat SUPERADMIN, menejer faqat o'z
 * filiali kassasi kartalari (boshqa filial — 403), PATCH (Asosiy kartada
 * ham), make-default, ko'chirma Excel, to'lovlarda filial kartasi.
 */
describe('Zv3MLn0a — /finance/cashbox/cards gateway kontrakti', () => {
  let app: INestApplication;
  let user: Record<string, unknown> = { sub: '9', roles: ['superadmin'] };
  const finance = {
    send: jest.fn((): any => of({ statusCode: 200, data: { ok: true } })),
  };
  const branch = {
    send: jest.fn(() => of({ statusCode: 200, data: { id: '13' } })),
  };

  const SUPERADMIN = { sub: '9', roles: ['superadmin'] };
  const ADMIN = { sub: '8', roles: ['admin'] };
  const MANAGER = { sub: '25', roles: ['manager'], branch_id: '13' };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FinanceGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: branch },
        { provide: 'ORDER', useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => any };
        }) => {
          context.switchToHttp().getRequest().user = user;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
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

  beforeEach(() => {
    user = SUPERADMIN;
    finance.send.mockClear();
    finance.send.mockImplementation(() =>
      of({ statusCode: 200, data: { ok: true } }),
    );
  });

  const lastCall = () =>
    (finance.send.mock.calls as unknown as Array<[{ cmd: string }, any]>).at(
      -1,
    );

  it('POST: tafsilotlar finance ga; last4 4 raqamdan uzun / raqam emas → 400 (finance chaqirilmaydi); noma`lum tur → 400', async () => {
    const ok = await request(app.getHttpServer())
      .post('/finance/cashbox/cards')
      .send({
        name: 'Humo virtual',
        kind: 'virtual_card',
        bank_name: 'Hamkorbank',
        card_network: 'Humo',
        last4: '4417',
        holder_name: 'Aziz Rahimov',
        note: 'Click',
        branch_id: '13',
        make_default: true,
      });
    expect(ok.status).toBe(201);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.create' },
      {
        name: 'Humo virtual',
        kind: 'virtual_card',
        bank_name: 'Hamkorbank',
        card_network: 'Humo',
        last4: '4417',
        holder_name: 'Aziz Rahimov',
        note: 'Click',
        branch_id: '13',
        make_default: true,
        created_by: '9',
      },
    ]);

    finance.send.mockClear();
    for (const body of [
      { name: 'K', last4: '8600123412341234' },
      { name: 'K', last4: '12345' },
      { name: 'K', last4: '12a4' },
      { name: 'K', last4: 1234 },
      { name: 'K', kind: 'crypto' },
      { name: 'K', card_number: '8600123412341234' },
    ]) {
      const bad = await request(app.getHttpServer())
        .post('/finance/cashbox/cards')
        .send(body);
      expect(bad.status).toBe(400);
    }
    const pan = await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3')
      .send({ last4: '8600123412341234' });
    expect(pan.status).toBe(400);
    expect(JSON.stringify(pan.body)).toContain('last4');
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('smena sozlamalari: ADMIN → 403 (yaratish ham, tahrir ham); SUPERADMIN → allow_shift_settings', async () => {
    user = ADMIN;
    for (const [method, url] of [
      ['post', '/finance/cashbox/cards'],
      ['patch', '/finance/cashbox/cards/3'],
    ] as const) {
      const res = await request(app.getHttpServer())
        [method](url)
        .send({ name: 'K', require_photo_on_shift_close: true });
      expect(res.status).toBe(403);
    }
    const ai = await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3')
      .send({ ai_check_enabled: false });
    expect(ai.status).toBe(403);
    expect(finance.send).not.toHaveBeenCalled();

    // ADMIN boshqa maydonlarni o'zgartira oladi (bayroqsiz).
    await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3')
      .send({ bank_name: 'Agrobank' });
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.update' },
      { bank_name: 'Agrobank', id: '3', updated_by: '8' },
    ]);

    user = SUPERADMIN;
    await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3')
      .send({ require_photo_on_shift_close: true, ai_check_enabled: true });
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.update' },
      {
        require_photo_on_shift_close: true,
        ai_check_enabled: true,
        allow_shift_settings: true,
        id: '3',
        updated_by: '9',
      },
    ]);
  });

  it('PATCH: faqat nom — eski `rename` buyrug`i; bo`sh body → 400; make-default → make_default', async () => {
    await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3')
      .send({ name: 'Uzcard' });
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.rename' },
      { id: '3', name: 'Uzcard', updated_by: '9' },
    ]);
    finance.send.mockClear();
    const empty = await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3')
      .send({});
    expect(empty.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();

    const md = await request(app.getHttpServer()).post(
      '/finance/cashbox/cards/7/make-default',
    );
    expect(md.status).toBe(201);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.make_default' },
      { id: '7', updated_by: '9' },
    ]);
  });

  it('⭐ MENEJER: ro`yxat / jurnal / ko`chirma — doim o`z filiali (branch_id JWT dan); boshqa filial → 403', async () => {
    user = MANAGER;
    await request(app.getHttpServer()).get('/finance/cashbox/cards');
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.list' },
      { include_inactive: false, branch_id: '13' },
    ]);
    await request(app.getHttpServer()).get(
      '/finance/cashbox/cards?branch_id=13',
    );
    expect(lastCall()?.[1]).toMatchObject({ branch_id: '13' });

    finance.send.mockClear();
    for (const url of [
      '/finance/cashbox/cards?branch_id=14',
      '/finance/cashbox/cards/movements?branch_id=14',
    ]) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).toBe(403);
    }
    expect(finance.send).not.toHaveBeenCalled();

    await request(app.getHttpServer()).get('/finance/cashbox/cards/5/ledger');
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.ledger' },
      expect.objectContaining({ id: '5', branch_id: '13' }),
    ]);
    await request(app.getHttpServer()).get(
      '/finance/cashbox/cards/movements?card_id=5',
    );
    expect(lastCall()?.[1]).toMatchObject({ card_id: '5', branch_id: '13' });

    // Finance doirani tekshiradi: boshqa filial kartasi → 403 o'tadi.
    finance.send.mockImplementationOnce(() =>
      throwError(() => ({
        statusCode: 403,
        message: 'Bu karta sizning filialingiz kassasiga tegishli emas',
      })),
    );
    const foreign = await request(app.getHttpServer()).get(
      '/finance/cashbox/cards/99/ledger',
    );
    expect(foreign.status).toBe(403);
  });

  it('SUPERADMIN: branch_id ixtiyoriy (yo`q — asosiy kassa), noto`g`ri branch_id → 400', async () => {
    await request(app.getHttpServer()).get('/finance/cashbox/cards');
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.list' },
      { include_inactive: false },
    ]);
    await request(app.getHttpServer()).get(
      '/finance/cashbox/cards?branch_id=14&include_inactive=true',
    );
    expect(lastCall()?.[1]).toEqual({
      include_inactive: true,
      branch_id: '14',
    });
    finance.send.mockClear();
    const bad = await request(app.getHttpServer()).get(
      '/finance/cashbox/cards?branch_id=abc',
    );
    expect(bad.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('GET /:id/ledger/export — xlsx, oraliqdagi barcha qatorlar (`all: true`)', async () => {
    finance.send.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          card: { id: '5', name: 'Humo' },
          items: [
            {
              kind: 'income',
              created_at: '2026-10-25T10:00:00.000Z',
              amount: 1000,
              delta: 1000,
              balance_after: 1000,
              payment_method: 'click',
              comment: '=HYPERLINK("x")',
            },
          ],
        },
      }),
    );
    const res = await request(app.getHttpServer())
      .get('/finance/cashbox/cards/5/ledger/export?from_date=2026-10-01')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('karta-5');
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.ledger' },
      expect.objectContaining({ id: '5', from_date: '2026-10-01', all: true }),
    ]);
  });

  it('to`lovlar: filial→HQ `branch_card_id` finance ga; kuryerdan qabul DTO `card_id` ni qabul qiladi (raqam bo`lmasa xato)', async () => {
    await request(app.getHttpServer())
      .post('/finance/cashbox/payment/branch-to-main')
      .send({
        branch_id: '13',
        amount: 1000,
        payment_method: 'click',
        card_id: '3',
        branch_card_id: '7',
      });
    expect(lastCall()?.[1]).toMatchObject({
      branch_id: '13',
      card_id: '3',
      branch_card_id: '7',
    });

    const dto = (body: Record<string, unknown>, cls: any) =>
      validate(plainToInstance(cls, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(
      await dto(
        {
          courier_id: '501',
          amount: 1000,
          payment_method: 'click',
          card_id: '7',
        },
        PaymentFromCourierRequestDto,
      ),
    ).toEqual([]);
    expect(
      (
        await dto(
          {
            courier_id: '501',
            amount: 1000,
            payment_method: 'click',
            card_id: 'x',
          },
          PaymentFromCourierRequestDto,
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await dto(
          {
            branch_id: '13',
            amount: 1,
            payment_method: 'click',
            branch_card_id: '12a',
          },
          PaymentBranchToMainRequestDto,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
