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
 * BE-B (ega 2026-11-10: «24 soat ichida keyin yuklash») — gateway:
 * `POST /finance/shift/:shift_id/accounts/:card_id/late-photo`:
 *  - rollar: superadmin / admin — OK; menejer / registrator — 403 (fayl
 *    yuklanmaydi, finance chaqirilmaydi);
 *  - validatsiya (entered_balance majburiy ≥ 0, comment ≤ 1000, ID, rasm) — 400;
 *  - o'tkazish: `finance.shift.account_check.late_photo` (requester_roles),
 *    javob — hisobot qatori shakli (photo_url, kalit yashirin), AI fonda,
 *    finance qaytargan `previous_photo_file_key` (oldingi KEYIN yuklangan
 *    rasm; kassir qoralamasi — dalil, null) o'chiriladi; finance xato kodi
 *    (`code`, `deadline`) FE'ga
 *    yetadi, rad etilganda yetim fayl o'chiriladi;
 *  - hisobot `can_upload_late` — qoida && superadmin / admin.
 * Haqiqiy AI CHAQIRILMAYDI.
 */
describe('BE-B — gateway: avto-yopilgan smenaga karta rasmini keyin yuklash', () => {
  let app: INestApplication;
  type Reply = Observable<unknown>;
  const finance = { send: jest.fn((): Reply => of({})) };
  const file = { send: jest.fn((): Reply => of({})) };
  const ai = { send: jest.fn((): Reply => of({})) };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const previousAccessKey = process.env.ACCESS_TOKEN_KEY;

  beforeAll(async () => {
    process.env.ACCESS_TOKEN_KEY = 'BE-B-spec-access-token-key';
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
          const role = req.headers['x-test-role'] ?? 'superadmin';
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

  const URL = '/finance/shift/41/accounts/3/late-photo';

  const lateRow = {
    id: '7',
    shift_id: '41',
    card_id: '3',
    expected_balance: 100000,
    entered_balance: 99000,
    difference: -1000,
    photo_file_key: 'shift-check-late-1.jpg',
    ai_status: 'pending',
    ai_raw: null,
    comment: 'kassir yuklamagan',
    comment_required: true,
    confirmed_by: '9',
    photo_status: 'uploaded',
    late_upload_deadline: '2026-11-11T13:00:00.000Z',
    late_uploaded: true,
    can_upload_late: true,
  };

  const happyMocks = () => {
    file.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'file.upload'
        ? of({ data: { key: 'shift-check-late-1.jpg' } })
        : of({})) as never);
    finance.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'finance.shift.account_check.late_photo'
        ? of({
            statusCode: 201,
            data: {
              shift_id: '41',
              ai_enabled: true,
              ai_request_id: 'req-late-1',
              previous_photo_file_key: 'shift-check-old.jpg',
              check: lateRow,
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
  };

  const upload = (role: string) =>
    request(http())
      .post(URL)
      .set('x-test-role', role)
      .set('Host', 'api.elchipochta.uz')
      .set('X-Forwarded-Proto', 'https')
      .field('entered_balance', '99000')
      .field('comment', 'kassir yuklamagan')
      .attach('photo', jpegWithExif(), {
        filename: 'b.jpg',
        contentType: 'image/jpeg',
      });

  it('superadmin: EXIF tozalanadi → shift-check → finance late_photo → AI fonda; javob — hisobot qatori shakli', async () => {
    happyMocks();
    const res = await upload('superadmin');
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Shift account late photo uploaded');
    expect(res.body.data).toEqual(
      expect.objectContaining({
        card_id: '3',
        difference: -1000,
        ai_status: 'pending',
        photo_status: 'uploaded',
        late_upload_deadline: '2026-11-11T13:00:00.000Z',
        late_uploaded: true,
        can_upload_late: true,
        has_photo: true,
        photo_url: expect.stringMatching(
          /^https:\/\/api\.elchipochta\.uz\/files\/signed\/[A-Za-z0-9_-]+$/,
        ),
        photo_url_expires_in: 300,
        // Hisobot shakli: ai_raw — faqat superadmin.
        ai_raw: null,
      }),
    );
    expect(res.body.data.photo_file_key).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('shift-check-late-1.jpg');

    const [[, uploadReq]] = cmd(file.send, 'file.upload');
    expect(uploadReq.folder).toBe('shift-check');
    expect(
      Buffer.from(uploadReq.file_base64, 'base64').includes(Buffer.from('GPS')),
    ).toBe(false);

    const [[, payload]] = cmd(
      finance.send,
      'finance.shift.account_check.late_photo',
    );
    expect(payload).toEqual({
      shift_id: '41',
      card_id: '3',
      entered_balance: 99000,
      comment: 'kassir yuklamagan',
      photo_file_key: 'shift-check-late-1.jpg',
      requester_id: '9',
      requester_roles: ['superadmin'],
    });
    // Oldingi KEYIN yuklangan rasm o'chiriladi (qayta yuklash — oxirgisi
    // yutadi). Kassir qoralamasi (dalil) uchun finance kalit qaytarmaydi.
    expect(cmd(file.send, 'file.delete').map(([, p]) => p)).toEqual([
      { key: 'shift-check-old.jpg' },
    ]);

    await flush();
    await flush();
    const [[, aiReq]] = cmd(ai.send, 'ai.finance.balance_screenshot');
    expect(aiReq).toEqual(
      expect.objectContaining({ shift_id: '41', card_id: '3' }),
    );
    const [[, aiResult]] = cmd(
      finance.send,
      'finance.shift.account_check.ai_result',
    );
    expect(aiResult).toEqual({
      shift_id: '41',
      card_id: '3',
      ai_request_id: 'req-late-1',
      result: expect.objectContaining({ ok: true, balance: 100000 }),
    });
  });

  it('admin — OK (ai_raw yo‘q, can_upload_late saqlanadi); AI o‘chiq — ai-service chaqirilmaydi', async () => {
    happyMocks();
    finance.send.mockImplementation(() =>
      of({
        statusCode: 201,
        data: {
          shift_id: '41',
          ai_enabled: false,
          ai_request_id: null,
          previous_photo_file_key: null,
          check: { ...lateRow, ai_status: 'disabled', ai_raw: { x: 1 } },
        },
      }),
    );
    const res = await upload('admin');
    expect(res.status).toBe(201);
    expect(res.body.data.ai_raw).toBeUndefined();
    expect(res.body.data.can_upload_late).toBe(true);
    expect(res.body.data.ai_status).toBe('disabled');
    const [[, payload]] = cmd(
      finance.send,
      'finance.shift.account_check.late_photo',
    );
    expect(payload.requester_roles).toEqual(['admin']);
    await flush();
    expect(ai.send).not.toHaveBeenCalled();
    expect(cmd(file.send, 'file.delete')).toHaveLength(0);
  });

  it.each(['manager', 'registrator', 'courier', 'market'])(
    '%s — 403, fayl yuklanmaydi, finance chaqirilmaydi',
    async (role) => {
      happyMocks();
      const res = await upload(role);
      expect(res.status).toBe(403);
      expect(file.send).not.toHaveBeenCalled();
      expect(finance.send).not.toHaveBeenCalled();
    },
  );

  it('validatsiya — 400: entered_balance yo‘q / bo‘sh / manfiy / son emas, comment > 1000, ID noto‘g‘ri, rasm yo‘q / turi', async () => {
    happyMocks();
    const photo = () => jpegWithExif();
    // Har so'rov alohida (supertest serverni so'rov boshida ko'taradi).
    const cases: Array<() => request.Test> = [
      () =>
        request(http()).post(URL).attach('photo', photo(), {
          filename: 'b.jpg',
          contentType: 'image/jpeg',
        }),
      () =>
        request(http())
          .post(URL)
          .field('entered_balance', '')
          .attach('photo', photo(), {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          }),
      () =>
        request(http())
          .post(URL)
          .field('entered_balance', '-1')
          .attach('photo', photo(), {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          }),
      () =>
        request(http())
          .post(URL)
          .field('entered_balance', 'abc')
          .attach('photo', photo(), {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          }),
      () =>
        request(http())
          .post(URL)
          .field('entered_balance', '100')
          .field('comment', 'x'.repeat(1001))
          .attach('photo', photo(), {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          }),
      () =>
        request(http())
          .post('/finance/shift/abc/accounts/3/late-photo')
          .field('entered_balance', '100')
          .attach('photo', photo(), {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          }),
      () =>
        request(http())
          .post('/finance/shift/41/accounts/x1/late-photo')
          .field('entered_balance', '100')
          .attach('photo', photo(), {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          }),
      () => request(http()).post(URL).field('entered_balance', '100'),
      () =>
        request(http())
          .post(URL)
          .field('entered_balance', '100')
          .attach('photo', Buffer.from('GIF89a....'), {
            filename: 'a.gif',
            contentType: 'image/gif',
          }),
      () =>
        request(http())
          .post(URL)
          .field('entered_balance', '100')
          .field('shift_id', '99')
          .attach('photo', photo(), {
            filename: 'b.jpg',
            contentType: 'image/jpeg',
          }),
    ];
    for (const send of cases) {
      const res = await send();
      expect(res.status).toBe(400);
    }
    expect(file.send).not.toHaveBeenCalled();
    expect(finance.send).not.toHaveBeenCalled();
    // 0 — ruxsat (≥ 0).
    const zero = await request(http())
      .post(URL)
      .field('entered_balance', '0')
      .attach('photo', photo(), {
        filename: 'b.jpg',
        contentType: 'image/jpeg',
      });
    expect(zero.status).toBe(201);
    expect(
      cmd(finance.send, 'finance.shift.account_check.late_photo')[0][1]
        .entered_balance,
    ).toBe(0);
  });

  it.each([
    [
      409,
      'SHIFT_LATE_PHOTO_EXPIRED',
      "Rasmni keyin yuklash muddati tugagan (smena yopilganidan 24 soat o'tdi)",
      { deadline: '2026-11-11T13:00:00.000Z' },
    ],
    [
      409,
      'SHIFT_LATE_PHOTO_NOT_AUTO_CLOSED',
      'Rasmni keyin yuklash faqat avtomatik yopilgan smena uchun',
      {},
    ],
    [
      400,
      'SHIFT_LATE_PHOTO_MAIN_ONLY',
      'Rasmni keyin yuklash faqat asosiy kassa smenasi uchun',
      {},
    ],
    [
      404,
      'SHIFT_LATE_PHOTO_CARD_NOT_IN_SHIFT',
      "Bu karta shu smena hisobotida yo'q",
      {},
    ],
  ])(
    'finance %s %s — kod va maydonlar FE’ga yetadi, yetim fayl o‘chiriladi',
    async (status, code, message, extra) => {
      file.send.mockImplementation(((pattern: { cmd: string }) =>
        pattern.cmd === 'file.upload'
          ? of({ data: { key: 'orphan-late.jpg' } })
          : of({})) as never);
      finance.send.mockImplementation(() =>
        throwError(() => ({
          statusCode: status,
          message,
          code,
          internal_hint: 'sizmasin',
          ...extra,
        })),
      );
      const res = await upload('superadmin');
      expect(res.status).toBe(status);
      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: status,
          message,
          code,
          ...extra,
        }),
      );
      expect(res.body.internal_hint).toBeUndefined();
      expect(cmd(file.send, 'file.delete')[0][1]).toEqual({
        key: 'orphan-late.jpg',
      });
      await flush();
      expect(ai.send).not.toHaveBeenCalled();
    },
  );

  it('hisobot: `can_upload_late` — qoida && superadmin / admin (registrator / menejer — false)', async () => {
    finance.send.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          shift: { id: '41' },
          accounts: [
            {
              card_id: '3',
              photo_file_key: null,
              ai_raw: null,
              photo_status: 'pending',
              late_upload_deadline: '2026-11-11T13:00:00.000Z',
              late_uploaded: false,
              can_upload_late: true,
            },
            {
              card_id: '4',
              photo_file_key: null,
              ai_raw: null,
              photo_status: 'missing',
              late_upload_deadline: '2026-11-11T13:00:00.000Z',
              late_uploaded: false,
              can_upload_late: false,
            },
          ],
        },
      }),
    );
    for (const role of ['superadmin', 'admin']) {
      const res = await request(http())
        .get('/finance/shift/41/report')
        .set('x-test-role', role);
      expect(res.status).toBe(200);
      expect(
        res.body.data.accounts.map((row: any) => row.can_upload_late),
      ).toEqual([true, false]);
      expect(res.body.data.accounts[0]).toEqual(
        expect.objectContaining({
          photo_status: 'pending',
          late_upload_deadline: '2026-11-11T13:00:00.000Z',
          late_uploaded: false,
        }),
      );
    }
    for (const role of ['registrator', 'manager']) {
      const res = await request(http())
        .get('/finance/shift/41/report')
        .set('x-test-role', role);
      expect(res.status).toBe(200);
      expect(
        res.body.data.accounts.map((row: any) => row.can_upload_late),
      ).toEqual([false, false]);
      // Holat va muddat hammaga ko'rinadi (faqat tugma rolga bog'liq).
      expect(res.body.data.accounts[1].photo_status).toBe('missing');
    }
  });
});
