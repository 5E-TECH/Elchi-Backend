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
 * kiZgTybn — smena yopishda karta qoldig'i:
 *  - POST /finance/shift/account-photo: tur / hajm / magic-bytes, EXIF
 *    tozalanadi, file-service (`shift-check`) → finance attach; rad etilsa
 *    yetim fayl o'chiriladi; AI fonda (MOCK ai-service) → ai_result;
 *  - GET/PATCH /finance/shift/settings: o'qish — yopuvchi rollar (doira),
 *    o'zgartirish — faqat superadmin;
 *  - GET /finance/shift/:id/report: gateway havolasi (`files/signed/:token`,
 *    MinIO ichki manzili emas), ai_raw faqat SA;
 *  - POST /finance/shift/close: accounts[] validatsiyasi va uzun timeout.
 * Haqiqiy AI CHAQIRILMAYDI.
 */
describe('kiZgTybn — gateway: smena karta qoldig‘i rasmi, sozlamalar, hisobot', () => {
  let app: INestApplication;
  type Reply = Observable<unknown>;
  const finance = { send: jest.fn((): Reply => of({})) };
  const file = { send: jest.fn((): Reply => of({})) };
  const ai = { send: jest.fn((): Reply => of({})) };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  // Gateway havola tokeni (`file-link.ts`) shu sir'dan olinadi.
  const previousAccessKey = process.env.ACCESS_TOKEN_KEY;

  beforeAll(async () => {
    process.env.ACCESS_TOKEN_KEY = 'kiZgTybn-spec-access-token-key';
    const module = await Test.createTestingModule({
      controllers: [FinanceGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
        { provide: 'ORDER', useValue: { send: jest.fn() } },
        { provide: 'FILE', useValue: file },
        { provide: 'AI', useValue: ai },
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
  });

  // JPEG: SOI + APP1(EXIF, GPS) + SOS + EOI.
  const jpegWithExif = () => {
    const exif = Buffer.from('Exif\0\0GPS 41.31N');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(exif.length + 2);
    return Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      len,
      exif,
      Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x09, 0x09, 0xff, 0xd9]),
    ]);
  };

  const cmd = (mock: jest.Mock, name: string) =>
    (mock.mock.calls as unknown as Array<[{ cmd: string }, any]>).filter(
      ([pattern]) => pattern.cmd === name,
    );

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('rasm: EXIF tozalanadi, shift-check papkasiga yoziladi, attach → AI fonda → ai_result', async () => {
    file.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'file.upload'
        ? of({ data: { key: 'shift-check-1-photo.jpg' } })
        : of({
            data: { url: 'http://minio:9000/elchi-files/x?X-Amz-Expires=300' },
          })) as never);
    finance.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'finance.shift.account_check.attach_photo'
        ? of({
            statusCode: 201,
            data: {
              shift_id: '41',
              ai_enabled: true,
              ai_request_id: 'req-1',
              previous_photo_file_key: null,
              check: {
                card_id: '3',
                ai_status: 'pending',
                photo_file_key: 'shift-check-1-photo.jpg',
                ai_raw: null,
              },
            },
          })
        : of({ statusCode: 200, data: { applied: true } })) as never);
    ai.send.mockImplementation(() =>
      of({
        ok: true,
        balance: 100000,
        last4: '1234',
        date: null,
        confidence: 0.9,
        model: 'mock',
      }),
    );

    const res = await request(http())
      .post('/finance/shift/account-photo')
      .set('Host', 'api.elchipochta.uz')
      .set('X-Forwarded-Proto', 'https')
      .field('card_id', '3')
      .field('entered_balance', '100000')
      .attach('photo', jpegWithExif(), {
        filename: 'b.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        shift_id: '41',
        ai_enabled: true,
        photo_url: expect.stringMatching(
          /^https:\/\/api\.elchipochta\.uz\/files\/signed\/[A-Za-z0-9_-]+$/,
        ),
        photo_url_expires_in: 300,
      }),
    );
    // (prod 2026-10-26) MinIO ichki manzili / S3 imzosi brauzerga chiqmaydi.
    expect(JSON.stringify(res.body)).not.toMatch(/minio|:9000|X-Amz/);
    expect(res.body.data.check.photo_url).toMatch(
      /^https:\/\/api\.elchipochta\.uz\/files\/signed\//,
    );
    expect(cmd(file.send, 'file.get_url')).toHaveLength(0);
    expect(res.body.data.check.photo_file_key).toBeUndefined();
    expect(res.body.data.check.has_photo).toBe(true);

    const [[, upload]] = cmd(file.send, 'file.upload');
    expect(upload.folder).toBe('shift-check');
    const stored = Buffer.from(upload.file_base64, 'base64');
    expect(stored.includes(Buffer.from('GPS'))).toBe(false);

    const [[, attach]] = cmd(
      finance.send,
      'finance.shift.account_check.attach_photo',
    );
    expect(attach).toEqual(
      expect.objectContaining({
        card_id: '3',
        entered_balance: 100000,
        photo_file_key: 'shift-check-1-photo.jpg',
        requester_id: '9',
        // Registrator — faqat asosiy kassa.
        cashbox_user_id: '0',
      }),
    );

    await flush();
    await flush();
    const [[, aiReq]] = cmd(ai.send, 'ai.finance.balance_screenshot');
    expect(aiReq).toEqual(
      expect.objectContaining({
        media_type: 'image/jpeg',
        shift_id: '41',
        card_id: '3',
      }),
    );
    expect(
      Buffer.from(aiReq.image_base64, 'base64').includes(Buffer.from('GPS')),
    ).toBe(false);
    const [[, aiResult]] = cmd(
      finance.send,
      'finance.shift.account_check.ai_result',
    );
    expect(aiResult).toEqual({
      shift_id: '41',
      card_id: '3',
      ai_request_id: 'req-1',
      result: expect.objectContaining({ ok: true, balance: 100000 }),
    });
  });

  it('AI xatosi (ai-service yiqildi) — ai_result {ok:false, network}, so‘rov baribir 201', async () => {
    file.send.mockImplementation(() =>
      of({ data: { key: 'k.jpg', url: 'u' } }),
    );
    finance.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'finance.shift.account_check.attach_photo'
        ? of({
            data: { shift_id: '41', ai_enabled: true, ai_request_id: 'req-2' },
          })
        : of({ data: { applied: true } })) as never);
    ai.send.mockImplementation(() => throwError(() => new Error('boom')));
    const res = await request(http())
      .post('/finance/shift/account-photo')
      .field('card_id', '3')
      .attach('photo', jpegWithExif(), {
        filename: 'b.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(201);
    await flush();
    await flush();
    const [[, aiResult]] = cmd(
      finance.send,
      'finance.shift.account_check.ai_result',
    );
    expect(aiResult.result).toEqual({ ok: false, reason: 'network' });
  });

  it('AI o‘chiq — ai-service chaqirilmaydi', async () => {
    file.send.mockImplementation(() =>
      of({ data: { key: 'k.jpg', url: 'u' } }),
    );
    finance.send.mockImplementation(() =>
      of({ data: { shift_id: '41', ai_enabled: false, ai_request_id: null } }),
    );
    const res = await request(http())
      .post('/finance/shift/account-photo')
      .field('card_id', '3')
      .attach('photo', jpegWithExif(), {
        filename: 'b.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(201);
    await flush();
    expect(ai.send).not.toHaveBeenCalled();
  });

  it('tur / magic-bytes / hajm rad etiladi; file-service chaqirilmaydi', async () => {
    const gif = await request(http())
      .post('/finance/shift/account-photo')
      .field('card_id', '3')
      .attach('photo', Buffer.from('GIF89a....'), {
        filename: 'a.gif',
        contentType: 'image/gif',
      });
    expect(gif.status).toBe(400);
    const fake = await request(http())
      .post('/finance/shift/account-photo')
      .field('card_id', '3')
      .attach('photo', Buffer.from('<html>x</html>'), {
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      });
    expect(fake.status).toBe(400);
    const big = await request(http())
      .post('/finance/shift/account-photo')
      .field('card_id', '3')
      .attach(
        'photo',
        Buffer.concat([jpegWithExif(), Buffer.alloc(5 * 1024 * 1024)]),
        {
          filename: 'big.jpg',
          contentType: 'image/jpeg',
        },
      );
    expect(big.status).toBe(413);
    const none = await request(http())
      .post('/finance/shift/account-photo')
      .field('card_id', '3');
    expect(none.status).toBe(400);
    expect(file.send).not.toHaveBeenCalled();
  });

  it('attach rad etilsa (smena yopiq / begona karta) — yuklangan fayl o‘chiriladi', async () => {
    file.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'file.upload'
        ? of({ data: { key: 'orphan.jpg' } })
        : of({})) as never);
    finance.send.mockImplementation(() =>
      throwError(() => ({
        statusCode: 400,
        message: 'Smena allaqachon yopilgan',
      })),
    );
    const res = await request(http())
      .post('/finance/shift/account-photo')
      .set('x-test-role', 'manager')
      .field('card_id', '3')
      .attach('photo', jpegWithExif(), {
        filename: 'b.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(400);
    const [[, attach]] = cmd(
      finance.send,
      'finance.shift.account_check.attach_photo',
    );
    expect(attach.cashbox_user_id).toBe('13');
    expect(cmd(file.send, 'file.delete')[0][1]).toEqual({ key: 'orphan.jpg' });
  });

  it('PATCH settings — faqat superadmin; rollar finance’ga uzatiladi', async () => {
    const denied = await request(http())
      .patch('/finance/shift/settings')
      .set('x-test-role', 'admin')
      .send({ ai_check_enabled: true });
    expect(denied.status).toBe(403);
    finance.send.mockImplementation(() => of({ statusCode: 200, data: {} }));
    const ok = await request(http())
      .patch('/finance/shift/settings')
      .set('x-test-role', 'superadmin')
      .send({
        account_check_enabled: true,
        cards: [
          {
            card_id: '3',
            require_photo_on_shift_close: true,
            ai_check_enabled: true,
          },
        ],
      });
    expect(ok.status).toBe(200);
    const [[, payload]] = cmd(finance.send, 'finance.shift.settings.update');
    expect(payload).toEqual(
      expect.objectContaining({
        account_check_enabled: true,
        requester_id: '9',
        requester_roles: ['superadmin'],
      }),
    );
  });

  it('GET settings — menejer faqat o‘z filiali (boshqasi 403)', async () => {
    finance.send.mockImplementation(() => of({ statusCode: 200, data: {} }));
    const own = await request(http())
      .get('/finance/shift/settings')
      .set('x-test-role', 'manager');
    expect(own.status).toBe(200);
    expect(cmd(finance.send, 'finance.shift.settings.get')[0][1]).toEqual({
      cashbox_user_id: '13',
    });
    const other = await request(http())
      .get('/finance/shift/settings?cashbox_user_id=0')
      .set('x-test-role', 'manager');
    expect(other.status).toBe(403);
  });

  it('report — photo_url imzolanadi, kalit yashiriladi; ai_raw faqat superadmin', async () => {
    finance.send.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          shift: { id: '41' },
          accounts: [
            {
              card_id: '3',
              ai_status: 'match',
              photo_file_key: 'shift-check-9-k.jpg',
              ai_raw: { balance: 1 },
            },
            {
              card_id: '4',
              ai_status: 'not_required',
              photo_file_key: null,
              ai_raw: null,
            },
          ],
        },
      }),
    );
    const reg = await request(http())
      .get('/finance/shift/41/report')
      .set('Host', 'api.elchipochta.uz')
      .set('X-Forwarded-Proto', 'https');
    expect(reg.status).toBe(200);
    expect(cmd(finance.send, 'finance.shift.report')[0][1]).toEqual({
      shift_id: '41',
      cashbox_user_id: '0',
    });
    expect(reg.body.data.accounts[0]).toEqual(
      expect.objectContaining({
        photo_url: expect.stringMatching(
          /^https:\/\/api\.elchipochta\.uz\/files\/signed\/[A-Za-z0-9_-]+$/,
        ),
        photo_url_expires_in: 300,
        has_photo: true,
      }),
    );
    expect(JSON.stringify(reg.body)).not.toContain('shift-check-9-k.jpg');
    expect(file.send).not.toHaveBeenCalled();
    expect(reg.body.data.accounts[0].photo_file_key).toBeUndefined();
    expect(reg.body.data.accounts[0].ai_raw).toBeUndefined();
    expect(reg.body.data.accounts[1]).toEqual(
      expect.objectContaining({
        photo_url: null,
        photo_url_expires_in: null,
        has_photo: false,
      }),
    );
    const sa = await request(http())
      .get('/finance/shift/41/report')
      .set('x-test-role', 'superadmin');
    expect(sa.body.data.accounts[0].ai_raw).toEqual({ balance: 1 });
    expect(cmd(finance.send, 'finance.shift.report')[1][1]).toEqual({
      shift_id: '41',
    });
  });

  it('close — accounts[] validatsiyasi (manfiy / noto‘g‘ri card_id → 400), to‘g‘risi uzatiladi', async () => {
    finance.send.mockImplementation(() => of({ statusCode: 200, data: {} }));
    const bad = await request(http())
      .post('/finance/shift/close')
      .send({
        closing_balance_cash: 100,
        accounts: [{ card_id: 'x', entered_balance: -1 }],
      });
    expect(bad.status).toBe(400);
    const ok = await request(http())
      .post('/finance/shift/close')
      .send({
        closing_balance_cash: 100,
        accounts: [{ card_id: '3', entered_balance: 100000, comment: 'ok' }],
      });
    expect(ok.status).toBe(201);
    const [[, payload]] = cmd(finance.send, 'finance.shift.close');
    expect(payload.accounts).toEqual([
      { card_id: '3', entered_balance: 100000, comment: 'ok' },
    ]);
  });
});
