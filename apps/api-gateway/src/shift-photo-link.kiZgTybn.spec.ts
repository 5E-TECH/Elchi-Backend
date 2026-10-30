import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { FileGatewayController } from './file-gateway.controller';
import { FinanceGatewayController } from './finance-gateway.controller';
import {
  buildFileLinkUrl,
  createFileLinkToken,
  FILE_LINK_TTL_SECONDS,
  publicOrigin,
  readFileLinkToken,
} from './file-link';

/**
 * kiZgTybn — prod 2026-10-26 23:40: smena yopishdagi karta qoldig'i rasmi
 * havolasi (`photo_url`) `http://minio:9000/elchi-files/…?X-Amz-…` edi —
 * file-service S3 havolasini ICHKI `MINIO_ENDPOINT` bilan imzolaydi, MinIO
 * tashqariga chiqmagan, brauzer «Ochish» / «Rasmni ochish» ni ocha olmasdi.
 *
 * Endi havola — gateway: `https://<api>/files/signed/<token>` (300 s,
 * AES-GCM token), baytlar dalil fayllari kabi `file.read` orqali. Havolani
 * faqat kassa doirasi tekshirilgan smena endpoint'lari yaratadi; umumiy
 * `files/:key` / `files/:key/content` yo'li smena kalitini faqat
 * superadmin/admin'ga beradi.
 */
const SECRET = 'kiZgTybn-link-spec-access-token-key';
const KEY =
  'shift-check-1761500000000-0b0e6a52-2f6d-4c55-9c62-1f1b2c3d4e5f-balance.jpg';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

const tokenOf = (url: string | null | undefined): string =>
  String(url ?? '').split('/files/signed/')[1] ?? '';

describe('kiZgTybn — smena rasmi havolasi: gateway token (file-link)', () => {
  const previous = process.env.ACCESS_TOKEN_KEY;
  beforeEach(() => {
    process.env.ACCESS_TOKEN_KEY = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ACCESS_TOKEN_KEY;
    else process.env.ACCESS_TOKEN_KEY = previous;
  });

  const prodReq = {
    headers: { host: 'api.elchipochta.uz', 'x-forwarded-proto': 'https' },
    protocol: 'http',
  };

  it('⭐ URL shakli: ochiq API origin + /files/signed/<token>; ichki host, S3 imzosi, kalit YO‘Q', () => {
    const url = buildFileLinkUrl(prodReq, KEY);
    expect(url).toMatch(
      /^https:\/\/api\.elchipochta\.uz\/files\/signed\/[A-Za-z0-9_-]+$/,
    );
    expect(url).not.toMatch(/minio|:9000|X-Amz|elchi-files/i);
    expect(url).not.toContain(KEY);
    expect(url).not.toContain('shift-check');
    expect(readFileLinkToken(tokenOf(url))).toBe(KEY);
  });

  it('300 s: muddat ichida ochiladi, 300 s dan keyin — yo‘q', () => {
    const now = Date.UTC(2026, 9, 26, 18, 40);
    const token = createFileLinkToken(KEY, now)!;
    expect(readFileLinkToken(token, now)).toBe(KEY);
    expect(readFileLinkToken(token, now + 299_000)).toBe(KEY);
    expect(readFileLinkToken(token, now + FILE_LINK_TTL_SECONDS * 1000)).toBe(
      null,
    );
    // Soat orqaga ketgan / kelajakdan kelgan token (muddat > 300 s) — rad.
    expect(readFileLinkToken(token, now - 60_000)).toBeNull();
  });

  it('o‘zgartirilgan / boshqa sir bilan yasalgan / buzuq token — null', () => {
    const token = createFileLinkToken(KEY)!;
    const flipped =
      token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21);
    expect(readFileLinkToken(flipped)).toBeNull();
    expect(readFileLinkToken(`${token}x`)).toBeNull();
    expect(readFileLinkToken('')).toBeNull();
    expect(readFileLinkToken('not a token!')).toBeNull();
    expect(readFileLinkToken('A'.repeat(2000))).toBeNull();
    expect(readFileLinkToken(undefined)).toBeNull();

    process.env.ACCESS_TOKEN_KEY = 'another-secret-another-secret';
    expect(readFileLinkToken(token)).toBeNull();
    delete process.env.ACCESS_TOKEN_KEY;
    expect(readFileLinkToken(token)).toBeNull();
    expect(createFileLinkToken(KEY)).toBeNull();
  });

  it('faqat smena fayllari: dalil (`proof-`), katalog va boshqa kalitga havola yaratilmaydi', () => {
    for (const key of [
      'proof-1-x.png',
      'products-1.png',
      'expense-1.pdf',
      'x',
    ]) {
      expect(createFileLinkToken(key)).toBeNull();
      expect(buildFileLinkUrl(prodReq, key)).toBeNull();
    }
    expect(buildFileLinkUrl(prodReq, null)).toBeNull();
    expect(buildFileLinkUrl(prodReq, '  ')).toBeNull();
    expect(createFileLinkToken('shift-report-41.pdf')).not.toBeNull();
  });

  it('origin: X-Forwarded-Proto (tunnel) + Host; buzuq Host — nisbiy yo‘l', () => {
    expect(publicOrigin(prodReq)).toBe('https://api.elchipochta.uz');
    expect(
      publicOrigin({ headers: { host: 'localhost:3004' }, protocol: 'http' }),
    ).toBe('http://localhost:3004');
    expect(
      publicOrigin({
        headers: { host: 'evil.com/<x>', 'x-forwarded-proto': 'https' },
      }),
    ).toBe('');
    expect(buildFileLinkUrl({ headers: {} }, KEY)).toMatch(
      /^\/files\/signed\/[A-Za-z0-9_-]+$/,
    );
  });
});

describe('kiZgTybn — GET files/signed/:token va umumiy kalit yo‘li (file-gateway)', () => {
  const previous = process.env.ACCESS_TOKEN_KEY;
  beforeEach(() => {
    process.env.ACCESS_TOKEN_KEY = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ACCESS_TOKEN_KEY;
    else process.env.ACCESS_TOKEN_KEY = previous;
  });

  const makeController = () => {
    const fileClient = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: {
            body_base64: JPEG.toString('base64'),
            mime_type: 'image/jpeg',
            url: 'http://minio:9000/elchi-files/x?X-Amz-Expires=300',
          },
        }),
      ),
    };
    const orderClient = { send: jest.fn(() => of({ data: null })) };
    const controller = new FileGatewayController(
      fileClient as any,
      orderClient as any,
    );
    return { controller, fileClient, orderClient };
  };

  const makeRes = () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: jest.fn((name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      }),
      send: jest.fn((body: unknown) => body),
    };
    return { res, headers };
  };

  it('⭐ yaroqli token — baytlar `file.read` orqali, maxfiy sarlavhalar, rasm inline', async () => {
    const { controller, fileClient } = makeController();
    const { res, headers } = makeRes();
    await controller.getSignedFileContent(
      createFileLinkToken(KEY)!,
      res as any,
    );
    expect(fileClient.send).toHaveBeenCalledWith(
      { cmd: 'file.read' },
      { key: KEY },
    );
    expect(res.send).toHaveBeenCalledWith(JPEG);
    expect(headers['content-type']).toBe('image/jpeg');
    expect(headers['cache-control']).toBe('private, max-age=300');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain('sandbox');
    expect(headers['content-disposition']).toBe('inline');
    expect(headers['referrer-policy']).toBe('no-referrer');
  });

  it('hisobot fayli (PDF) — yuklab olish sifatida', async () => {
    const { controller, fileClient } = makeController();
    fileClient.send.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          body_base64: Buffer.from('%PDF-1.4').toString('base64'),
          mime_type: 'application/pdf',
          url: '',
        },
      }),
    );
    const { res, headers } = makeRes();
    await controller.getSignedFileContent(
      createFileLinkToken('shift-report-41.pdf')!,
      res as any,
    );
    expect(headers['content-disposition']).toBe(
      'attachment; filename="shift-report-41.pdf"',
    );
  });

  it('soxta / muddati o‘tgan token → 403, fayl o‘qilmaydi', async () => {
    const { controller, fileClient } = makeController();
    const expired = createFileLinkToken(
      KEY,
      Date.now() - (FILE_LINK_TTL_SECONDS + 1) * 1000,
    )!;
    for (const token of [expired, 'forged', `${createFileLinkToken(KEY)}A`]) {
      const { res } = makeRes();
      await expect(
        controller.getSignedFileContent(token, res as any),
      ).rejects.toThrow(ForbiddenException);
      expect(res.send).not.toHaveBeenCalled();
    }
    expect(fileClient.send).not.toHaveBeenCalled();
  });

  it('route: `files/signed/:token`, @Public (oddiy <a href> — Bearer yo‘q)', () => {
    const handler = (
      FileGatewayController.prototype as unknown as Record<string, unknown>
    ).getSignedFileContent;
    expect(Reflect.getMetadata('path', handler)).toBe('files/signed/:token');
    expect(Reflect.getMetadata('isPublic', handler)).toBe(true);
  });

  it('⭐ doira: umumiy `files/:key` / `files/:key/content` smena kalitini menejer/registrator/boshqalarga BERMAYDI', async () => {
    for (const roles of [
      ['manager'],
      ['registrator'],
      ['operator'],
      ['courier'],
      ['market'],
      ['customer'],
      [],
    ]) {
      const { controller, fileClient, orderClient } = makeController();
      const req = { user: { roles, sub: '25' } };
      await expect(controller.getFileUrl(KEY, req)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        controller.getFileContent(
          'shift-report-41.pdf',
          req,
          makeRes().res as any,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(fileClient.send).not.toHaveBeenCalled();
      expect(orderClient.send).not.toHaveBeenCalled();
    }
  });

  it('superadmin/admin — umumiy yo‘l avvalgidek (hammasi)', async () => {
    for (const role of ['superadmin', 'admin']) {
      const { controller, fileClient } = makeController();
      const { res } = makeRes();
      await controller.getFileContent(
        KEY,
        { user: { roles: [role], sub: '1' } },
        res as any,
      );
      expect(fileClient.send).toHaveBeenCalledWith(
        { cmd: 'file.read' },
        { key: KEY },
      );
    }
  });
});

describe('kiZgTybn — HTTP: smena hisoboti havolasi → baytlar (doira bilan)', () => {
  let app: INestApplication;
  type Reply = Observable<unknown>;
  const finance = { send: jest.fn((): Reply => of({})) };
  const file = { send: jest.fn((): Reply => of({})) };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const previous = process.env.ACCESS_TOKEN_KEY;

  beforeAll(async () => {
    process.env.ACCESS_TOKEN_KEY = SECRET;
    const module = await Test.createTestingModule({
      controllers: [FinanceGatewayController, FileGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
        { provide: 'ORDER', useValue: { send: jest.fn(() => of({})) } },
        { provide: 'FILE', useValue: file },
        { provide: 'AI', useValue: { send: jest.fn() } },
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
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previous === undefined) delete process.env.ACCESS_TOKEN_KEY;
    else process.env.ACCESS_TOKEN_KEY = previous;
  });

  beforeEach(() => {
    finance.send.mockReset();
    file.send.mockReset();
    file.send.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          body_base64: JPEG.toString('base64'),
          mime_type: 'image/jpeg',
        },
      }),
    );
  });

  const reportFor = (branch: string) =>
    of({
      statusCode: 200,
      data: {
        shift: { id: '41', cashbox_user_id: branch },
        accounts: [{ card_id: '3', ai_status: 'match', photo_file_key: KEY }],
      },
    });

  it('⭐ menejer — o‘z filiali (13) hisobotidagi havola brauzerda ochiladi (JWT’siz)', async () => {
    finance.send.mockImplementation(() => reportFor('13'));
    const report = await request(http())
      .get('/finance/shift/41/report')
      .set('Host', 'api.elchipochta.uz')
      .set('X-Forwarded-Proto', 'https')
      .set('x-test-role', 'manager');
    expect(report.status).toBe(200);
    expect(finance.send.mock.calls[0][1]).toEqual({
      shift_id: '41',
      cashbox_user_id: '13',
    });
    const url = report.body.data.accounts[0].photo_url as string;
    expect(url).toMatch(
      /^https:\/\/api\.elchipochta\.uz\/files\/signed\/[A-Za-z0-9_-]+$/,
    );
    expect(url).not.toMatch(/minio|X-Amz/);

    const path = new URL(url).pathname;
    const photo = await request(http()).get(path).buffer(true);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.headers['cache-control']).toBe('private, max-age=300');
    expect(Buffer.from(photo.body as Buffer)).toEqual(JPEG);
    expect(file.send).toHaveBeenCalledWith({ cmd: 'file.read' }, { key: KEY });
  });

  it('registrator — faqat asosiy kassa (0); superadmin/admin — doirasiz', async () => {
    finance.send.mockImplementation(() => reportFor('0'));
    await request(http()).get('/finance/shift/41/report');
    await request(http())
      .get('/finance/shift/41/report')
      .set('x-test-role', 'superadmin');
    await request(http())
      .get('/finance/shift/41/report')
      .set('x-test-role', 'admin');
    expect(finance.send.mock.calls.map(([, payload]) => payload)).toEqual([
      { shift_id: '41', cashbox_user_id: '0' },
      { shift_id: '41' },
      { shift_id: '41' },
    ]);
  });

  it('⭐ begona filial smenasi (finance 404) — havola YARATILMAYDI, fayl o‘qilmaydi', async () => {
    finance.send.mockImplementation(() =>
      throwError(
        () => new RpcException({ statusCode: 404, message: 'Smena topilmadi' }),
      ),
    );
    const res = await request(http())
      .get('/finance/shift/77/report')
      .set('x-test-role', 'manager');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('/files/signed/');
    expect(file.send).not.toHaveBeenCalled();
  });

  it('menejer kalitni bilsa ham umumiy yo‘l bilan ocha olmaydi (403)', async () => {
    const res = await request(http())
      .get(`/files/${encodeURIComponent(KEY)}/content`)
      .set('x-test-role', 'manager');
    expect(res.status).toBe(403);
    expect(file.send).not.toHaveBeenCalled();
  });

  it('o‘zgartirilgan havola → 403', async () => {
    const res = await request(http()).get('/files/signed/forged-token');
    expect(res.status).toBe(403);
    expect(file.send).not.toHaveBeenCalled();
  });

  it('fayl topilmasa (file-service 404) — 404', async () => {
    // file-service RPC xatosi gateway'ga oddiy obyekt bo'lib keladi.
    file.send.mockImplementation(() =>
      throwError(() => ({ statusCode: 404, message: 'Fayl topilmadi' })),
    );
    const token = createFileLinkToken(KEY)!;
    const res = await request(http()).get(`/files/signed/${token}`);
    expect(res.status).toBe(404);
  });
});
