import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { Observable, of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { FileGatewayController } from './file-gateway.controller';
import {
  createFileLinkToken,
  FILE_LINK_TTL_SECONDS,
  isFileLinkKey,
  readFileLinkToken,
} from './file-link';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * T3-1 (QlLf33Ma) — gateway: kassa cheki.
 *  • GET/PATCH /finance/receipt-settings — rollar, payload;
 *  • POST /finance/receipts — avval sozlama/rol (rasm o'chiq → fayl
 *    yuklanmaydi), jpeg/png/webp ≤ 5 MB, magic-bytes, EXIF tozalanadi,
 *    sha256 tozalangan baytdan, `cashbox-receipt` papkasi; qoralama rad
 *    etilsa fayl o'chiriladi; javobda 300 s havola, kalit yo'q;
 *  • `cashbox-receipt-` kaliti: imzolangan havola, umumiy `files/:key` —
 *    faqat superadmin/admin.
 */
const SECRET = 'T3-receipt-spec-access-token-key';
const KEY = 'cashbox-receipt-1761500000000-uuid-receipt.jpg';

describe('T3-1 — gateway: kassa cheki sozlamalari va yuklash', () => {
  let app: INestApplication;
  type Reply = Observable<unknown>;
  const finance = { send: jest.fn((): Reply => of({})) };
  const file = { send: jest.fn((): Reply => of({})) };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const previousAccessKey = process.env.ACCESS_TOKEN_KEY;

  beforeAll(async () => {
    process.env.ACCESS_TOKEN_KEY = SECRET;
    const module = await Test.createTestingModule({
      controllers: [FinanceGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
        { provide: 'ORDER', useValue: { send: jest.fn() } },
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

  const happyFinance = () =>
    finance.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'finance.receipt.create_draft'
        ? of({
            statusCode: 201,
            data: { receipt_id: '41', kind: 'manual_expense', state: 'draft' },
          })
        : of({ statusCode: 200, data: {} })) as never);

  const upload = (
    role: string,
    kind: string,
    body: Buffer,
    name = 'chek.jpg',
    contentType = 'image/jpeg',
  ) =>
    request(http())
      .post('/finance/receipts')
      .set('x-test-role', role)
      .field('kind', kind)
      .attach('photo', body, { filename: name, contentType });

  it('⭐ yuklash: avval upload_check, EXIF tozalanadi, sha256 tozalangan baytdan, cashbox-receipt papkasi; javobda 300 s havola, kalit yo`q', async () => {
    happyFinance();
    file.send.mockImplementation(() => of({ data: { key: KEY } }));

    const res = await upload('superadmin', 'manual_expense', jpegWithExif());

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      receipt_id: '41',
      kind: 'manual_expense',
      state: 'draft',
      photo_url_expires_in: FILE_LINK_TTL_SECONDS,
    });
    expect(String(res.body.data.photo_url)).toContain('/files/signed/');
    expect(JSON.stringify(res.body)).not.toContain(KEY);

    const order = (finance.send.mock.calls as any[]).map(([p]) => p.cmd);
    expect(order[0]).toBe('finance.receipt.upload_check');
    const [[, uploadPayload]] = cmd(file.send, 'file.upload');
    expect(uploadPayload.folder).toBe('cashbox-receipt');
    const stored = Buffer.from(uploadPayload.file_base64, 'base64');
    expect(stored.toString('latin1')).not.toContain('GPS');
    const [[, draftPayload]] = cmd(
      finance.send,
      'finance.receipt.create_draft',
    );
    expect(draftPayload).toMatchObject({
      kind: 'manual_expense',
      file_key: KEY,
      mime: 'image/jpeg',
      size_bytes: stored.length,
      requester_id: '9',
      requester_roles: ['superadmin'],
      file_sha256: createHash('sha256').update(stored).digest('hex'),
    });
  });

  it('menejer: filial JWT`dan uzatiladi', async () => {
    happyFinance();
    file.send.mockImplementation(() => of({ data: { key: KEY } }));
    const res = await upload('manager', 'manual_expense', jpegWithExif());
    expect(res.status).toBe(201);
    expect(cmd(finance.send, 'finance.receipt.upload_check')[0][1]).toEqual({
      kind: 'manual_expense',
      requester_roles: ['manager'],
      branch_id: '13',
    });
    expect(
      cmd(finance.send, 'finance.receipt.create_draft')[0][1].branch_id,
    ).toBe('13');
  });

  it('⭐ rasm o`chiq (RECEIPT_DISABLED) — fayl file-service`ga YUBORILMAYDI, kod FE`ga yetadi', async () => {
    finance.send.mockImplementation(() =>
      throwError(
        () =>
          new RpcException({
            statusCode: 400,
            code: 'RECEIPT_DISABLED',
            message: "Bu operatsiya uchun chek rasmi o'chirilgan",
          }),
      ),
    );
    const res = await upload('superadmin', 'courier_to_hq', jpegWithExif());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RECEIPT_DISABLED');
    expect(file.send).not.toHaveBeenCalled();
  });

  it('menejer courier_to_hq — finance 403, fayl yuklanmaydi', async () => {
    finance.send.mockImplementation(() =>
      throwError(
        () => new RpcException({ statusCode: 403, message: 'ruxsat yo‘q' }),
      ),
    );
    const res = await upload('manager', 'courier_to_hq', jpegWithExif());
    expect(res.status).toBe(403);
    expect(file.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      '6 MB',
      Buffer.concat([jpegWithExif(), Buffer.alloc(6 * 1024 * 1024)]),
      'a.jpg',
      'image/jpeg',
    ],
    ['gif', Buffer.from('GIF89a......'), 'a.gif', 'image/gif'],
    ['.jpg nomli pdf', Buffer.from('%PDF-1.4 fake'), 'chek.jpg', 'image/jpeg'],
  ])('⭐ %s → 400, fayl saqlanmaydi', async (_n, body, name, type) => {
    happyFinance();
    const res = await upload('superadmin', 'manual_expense', body, name, type);
    expect(res.status).toBe(400);
    expect(file.send).not.toHaveBeenCalled();
    expect(cmd(finance.send, 'finance.receipt.create_draft')).toHaveLength(0);
  });

  it('noto`g`ri kind → 400 (DTO)', async () => {
    const res = await upload('superadmin', 'salary', jpegWithExif());
    expect(res.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('qoralama rad etilsa — yetim fayl o`chiriladi', async () => {
    finance.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'finance.receipt.create_draft'
        ? throwError(
            () =>
              new RpcException({
                statusCode: 400,
                code: 'RECEIPT_DISABLED',
                message: 'x',
              }),
          )
        : of({ statusCode: 200, data: {} })) as never);
    file.send.mockImplementation(((pattern: { cmd: string }) =>
      pattern.cmd === 'file.upload'
        ? of({ data: { key: KEY } })
        : of({})) as never);
    const res = await upload('superadmin', 'manual_expense', jpegWithExif());
    expect(res.status).toBe(400);
    await new Promise((resolve) => setImmediate(resolve));
    expect(cmd(file.send, 'file.delete')).toEqual([
      [{ cmd: 'file.delete' }, { key: KEY }],
    ]);
  });

  it('PATCH receipt-settings: payload + requester; noto`g`ri tur → 400', async () => {
    finance.send.mockImplementation(() => of({ statusCode: 200, data: {} }));
    const ok = await request(http())
      .patch('/finance/receipt-settings')
      .send({ manual_expense: { photo_required: false } });
    expect(ok.status).toBe(200);
    expect(cmd(finance.send, 'finance.receipt.settings.update')[0][1]).toEqual({
      manual_expense: { photo_required: false },
      requester_id: '9',
      requester_roles: ['superadmin'],
    });
    const bad = await request(http())
      .patch('/finance/receipt-settings')
      .send({ manual_expense: { photo_required: 'yo`q' } });
    expect(bad.status).toBe(400);
  });

  it('rollar: GET — SA/admin/menejer; PATCH — faqat SA; yuklash — SA/admin/menejer', () => {
    const proto = FinanceGatewayController.prototype;
    const handler = (name: keyof FinanceGatewayController): object =>
      Object.getOwnPropertyDescriptor(proto, name)?.value as object;
    const roles = (name: keyof FinanceGatewayController) =>
      [...(Reflect.getMetadata(ROLES_KEY, handler(name)) as string[])].sort();
    expect(roles('getReceiptSettings')).toEqual(
      ['admin', 'manager', 'superadmin'].sort(),
    );
    expect(roles('updateReceiptSettings')).toEqual(['superadmin']);
    expect(roles('uploadReceipt')).toEqual(
      ['admin', 'manager', 'superadmin'].sort(),
    );
    for (const name of [
      'getReceiptSettings',
      'updateReceiptSettings',
      'uploadReceipt',
    ] as const) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toContain(
        RolesGuard,
      );
    }
  });
  // ───────────────────────── T3-4: xulosa ─────────────────────────

  it('⭐ GET /finance/receipts/summary — `receipts/:id` ga tushmaydi; davr/kind/ai_status + rollar finance`ga', async () => {
    finance.send.mockReturnValue(
      of({ statusCode: 200, data: { counts: { match: 3 } } }),
    );
    const res = await request(http())
      .get('/finance/receipts/summary')
      .query({
        from: '2026-10-01',
        to: '2026-10-30',
        kind: 'manual_expense',
        ai_status: 'mismatch',
      })
      .set('x-test-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ counts: { match: 3 } });
    expect(cmd(finance.send, 'finance.receipt.get')).toHaveLength(0);
    const [[, payload]] = cmd(finance.send, 'finance.receipt_checks.summary');
    expect(payload).toEqual({
      from: '2026-10-01',
      to: '2026-10-30',
      kind: 'manual_expense',
      ai_status: 'mismatch',
      requester_roles: ['admin'],
    });
  });

  it.each(['manager', 'courier'])(
    'GET /finance/receipts/summary: %s → 403 (finance`ga bormaydi)',
    async (role) => {
      const res = await request(http())
        .get('/finance/receipts/summary')
        .set('x-test-role', role);
      expect(res.status).toBe(403);
      expect(finance.send).not.toHaveBeenCalled();
    },
  );

  it('GET /finance/receipts/summary: noto`g`ri sana / kind → 400', async () => {
    for (const query of [{ from: '01.10.2026' }, { kind: 'salary' }]) {
      const res = await request(http())
        .get('/finance/receipts/summary')
        .query(query);
      expect(res.status).toBe(400);
    }
    expect(finance.send).not.toHaveBeenCalled();
  });
});

describe('T3-1 — cashbox-receipt- fayl kaliti: havola va umumiy yo`l', () => {
  const previous = process.env.ACCESS_TOKEN_KEY;
  beforeEach(() => {
    process.env.ACCESS_TOKEN_KEY = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ACCESS_TOKEN_KEY;
    else process.env.ACCESS_TOKEN_KEY = previous;
  });

  it('⭐ imzolangan havola 300 s ochiladi, keyin — yo`q', () => {
    expect(isFileLinkKey(KEY)).toBe(true);
    const now = Date.now();
    const token = createFileLinkToken(KEY, now) as string;
    expect(token).toBeTruthy();
    expect(readFileLinkToken(token, now + 299_000)).toBe(KEY);
    expect(readFileLinkToken(token, now + 301_000)).toBeNull();
  });

  it('⭐ kuryer (va menejer, registrator) GET /files/cashbox-receipt-… → 403; superadmin/admin — ruxsat', async () => {
    const fileClient = {
      send: jest.fn(() => of({ statusCode: 200, data: { url: 'u' } })),
    };
    const controller = new FileGatewayController(
      fileClient as any,
      { send: jest.fn(() => of({ data: null })) } as any,
    );
    for (const roles of [['courier'], ['manager'], ['registrator'], []]) {
      await expect(
        controller.getFileUrl(KEY, { user: { roles, sub: '5' } }),
      ).rejects.toThrow(ForbiddenException);
    }
    expect(fileClient.send).not.toHaveBeenCalled();
    for (const roles of [['superadmin'], ['admin']]) {
      await expect(
        controller.getFileUrl(KEY, { user: { roles, sub: '1' } }),
      ).resolves.toBeTruthy();
    }
  });
});
