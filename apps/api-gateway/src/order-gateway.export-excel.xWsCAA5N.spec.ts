import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import { PassThrough } from 'node:stream';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { ExcelGatewayController } from './excel-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_HEADERS,
  streamOrdersXlsx,
  type OrderExportPage,
} from './order-export/orders-xlsx.export';

/**
 * xWsCAA5N — buyurtmalar eksporti (`GET /orders/export/excel`).
 *
 * Karta: frontend 100 talik sahifalab 100-sahifada (10 000 qator) JIMGINA
 * to'xtardi, `fetch_all` esa 5 000 bilan cheklangan. Karta qarori: 5 000
 * yetmasa — serverda BeePost'dagidek stream endpoint. Bu spec:
 *   - TC2: 10 000 dan ortiq buyurtma TO'LIQ chiqadi; chegaradan oshsa ANIQ
 *     ogohlantirish (sarlavha + faylda DIQQAT qatori);
 *   - TC3: bitta HTTP so'rov;
 *   - TC4: haqiqiy .xlsx (openxml, zip);
 *   - TC5: «Jami» qatori;
 *   - TC1/TC6 (regressiya): kuryer ismi, filtr/doira GET /orders bilan AYNAN.
 *
 * order-service `find_all_enriched` soxtasi uning sahifalash qoidasini
 * takrorlaydi (sukut 100, `max_limit` bilan 500 gacha, `fetch_all` — 5000):
 * shunda gateway sahifalari to'g'ri so'ralmasa test QIZIL bo'ladi.
 */

type Order = Record<string, unknown>;

const makeOrder = (id: number): Order => ({
  id: String(id),
  status: id % 3 === 0 ? 'sold' : 'new',
  total_price: 1000 * ((id % 7) + 1),
  createdAt: '2026-10-14T10:05:00.000Z',
  market: { id: '37', name: 'TEST Market' },
  customer: { id: '153', name: 'Ali', phone_number: '+998901112233' },
  region: { id: '3', name: 'Andijon' },
  district: { id: '30', name: 'Asaka' },
  items: [{ product_id: '10', product: { id: '10', name: 'Kitob' } }],
  courier:
    id % 2 === 0
      ? { id: '26', name: 'TEST Claude Kuryer', phone_number: '+998887009102' }
      : null,
});

/** order-service `normalizePagination` bilan bir xil sahifa hajmi. */
const servicePageSize = (query: Record<string, unknown>): number => {
  if (query.fetch_all === true || String(query.fetch_all) === 'true') {
    return 5000;
  }
  const maxLimit = Number(query.max_limit);
  const cap =
    Number.isFinite(maxLimit) && maxLimit > 100 ? Math.min(maxLimit, 500) : 100;
  const limit = Number(query.limit ?? 10);
  return Math.min(Number.isFinite(limit) && limit > 0 ? limit : 10, cap);
};

const pagedOrders = (total: number) => (query: Record<string, unknown>) => {
  const size = servicePageSize(query);
  const page = Math.max(1, Number(query.page ?? 1));
  const start = (page - 1) * size;
  const data: Order[] = [];
  for (let i = start; i < Math.min(start + size, total); i++) {
    data.push(makeOrder(total - i));
  }
  return { data, total, page, limit: size };
};

const binary = (
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const readSheet = async (buffer: Buffer) => {
  const wb = new Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Buyurtmalar')!;
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values as unknown[]).slice(1));
  });
  return rows;
};

const col = (key: string) =>
  ORDER_EXPORT_COLUMNS.findIndex((c) => c.key === key);

describe('xWsCAA5N — GET /orders/export/excel', () => {
  // 12 345 qatorli fayl yuk ostida (to'liq jest parallel) 5 s dan oshishi mumkin.
  jest.setTimeout(30_000);
  let app: INestApplication;
  let user: Record<string, unknown> = { sub: '1', roles: ['superadmin'] };
  let total = 0;
  let failFirstPage = false;
  const orderSend = jest.fn();
  const identitySend = jest.fn(() => of({ data: {} }));
  const branchSend = jest.fn(() => of({ data: null }));
  const noop = { send: jest.fn(() => of({ data: {} })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: { send: branchSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            ...user,
            roles: [...((user.roles as string[]) ?? [])],
          };
          return true;
        },
      })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    user = { sub: '1', roles: ['superadmin'] };
    total = 0;
    failFirstPage = false;
    orderSend.mockReset();
    orderSend.mockImplementation(
      (
        pattern: { cmd: string },
        payload: { query?: Record<string, unknown> },
      ) => {
        if (
          pattern.cmd === 'order.find_all_enriched' ||
          pattern.cmd === 'order.find_all'
        ) {
          if (failFirstPage) {
            return throwError(() => new Error('order-service yiqildi'));
          }
          return of(pagedOrders(total)(payload?.query ?? {}));
        }
        return of({ data: {} });
      },
    );
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const exportGet = (qs = '') =>
    request(http())
      .get(`/orders/export/excel${qs}`)
      .buffer(true)
      .parse(binary as any);
  const listQueries = () =>
    (orderSend.mock.calls as Array<[{ cmd: string }, { query: Order }]>)
      .filter((c) => c[0].cmd === 'order.find_all_enriched')
      .map((c) => c[1].query);

  it('⭐ TC2/TC3: 12 345 buyurtma — BITTA HTTP so‘rov, faylda 12 345 qatorning HAMMASI (10 000 da kesilmaydi)', async () => {
    total = 12_345;

    const res = await exportGet();

    expect(res.status).toBe(200);
    expect(res.headers[ORDER_EXPORT_HEADERS.total.toLowerCase()]).toBe('12345');
    expect(res.headers[ORDER_EXPORT_HEADERS.truncated.toLowerCase()]).toBe(
      'false',
    );

    const rows = await readSheet(res.body as Buffer);
    // sarlavha + 12 345 buyurtma + «Jami»
    expect(rows).toHaveLength(1 + 12_345 + 1);
    const ids = rows.slice(1, -1).map((r) => r[col('id')]);
    expect(new Set(ids).size).toBe(12_345);
    expect(ids[0]).toBe('12345');
    expect(ids[ids.length - 1]).toBe('1');
    // Ogohlantirish qatori YO'Q (hammasi chiqdi).
    expect(rows.some((r) => String(r[0]).startsWith('DIQQAT'))).toBe(false);

    // Gateway order-service'ni 500 talik sahifalar bilan aylanadi.
    const queries = listQueries();
    expect(queries).toHaveLength(Math.ceil(12_345 / 500));
    expect(queries.map((q) => q.page)).toEqual(
      Array.from({ length: queries.length }, (_, i) => i + 1),
    );
    for (const q of queries) {
      expect(q).toEqual(
        expect.objectContaining({ limit: 500, max_limit: 500 }),
      );
      expect(q.fetch_all).toBeUndefined();
    }
  });

  it('⭐ TC4: haqiqiy .xlsx — openxml content-type, zip imzosi, .xlsx nomi', async () => {
    total = 3;

    const res = await exportGet();

    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="barcha_buyurtmalar_\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    const body = res.body as Buffer;
    // ZIP (OOXML) imzosi "PK\x03\x04" — HTML emas.
    expect(body.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(body.toString('utf8', 0, 200)).not.toMatch(/<html|<!doctype/i);
    const rows = await readSheet(body);
    expect(rows[0]).toEqual(ORDER_EXPORT_COLUMNS.map((c) => c.header));
  });

  it('⭐ TC5: oxirgi qator «Jami» — buyurtmalar soni va Narxi yig‘indisi', async () => {
    total = 1_234;
    let expectedSum = 0;
    for (let id = 1; id <= total; id++) {
      expectedSum += Number(makeOrder(id).total_price);
    }

    const rows = await readSheet((await exportGet()).body as Buffer);

    const last = rows[rows.length - 1];
    expect(last[col('n')]).toBe('Jami');
    expect(String(last[col('products')])).toBe('1 234 ta buyurtma');
    expect(last[col('total_price')]).toBe(expectedSum);
  });

  it('⭐ TC1 (regressiya): Kuryer ustuni — courier.name; kuryer telefoni faylga yozilmaydi', async () => {
    total = 4;

    const res = await exportGet();
    const rows = await readSheet(res.body as Buffer);

    const byId = new Map(
      rows.slice(1, -1).map((r) => [String(r[col('id')]), r] as const),
    );
    expect(byId.get('4')?.[col('courier')]).toBe('TEST Claude Kuryer');
    expect(byId.get('3')?.[col('courier')] ?? '').toBe('');
    expect((res.body as Buffer).includes('887009102')).toBe(false);
    expect(byId.get('3')?.[col('status')]).toBe('Sotilgan');
    expect(byId.get('3')?.[col('created_at')]).toBe('2026-10-14 15:05');
  });

  it('⭐ TC6 (regressiya): filtr va doira GET /orders bilan AYNAN — market: market_id = token sub', async () => {
    total = 2;
    user = { sub: '37', roles: ['market'] };
    const filters =
      '?status=sold&start_day=2026-10-01&end_day=2026-10-14&region_id=3&search=Ali&sort_by=total_price&sort_dir=asc';

    await request(http()).get(`/orders${filters}&page=1&limit=10`);
    const listQuery: Order = { ...listQueries()[0] };
    orderSend.mockClear();
    await exportGet(filters);
    const exportQuery: Order = { ...listQueries()[0] };

    for (const key of ['page', 'limit', 'max_limit', 'fetch_all']) {
      delete listQuery[key];
      delete exportQuery[key];
    }
    expect(exportQuery).toEqual(listQuery);
    expect(exportQuery).toEqual(
      expect.objectContaining({
        market_id: '37',
        status: ['sold'],
        region_id: '3',
        start_day: '2026-10-01',
        end_day: '2026-10-14',
      }),
    );
  });

  it('market boshqa market_id bilan → 400 (GET /orders kabi), order-service chaqirilmaydi', async () => {
    total = 5;
    user = { sub: '37', roles: ['market'] };

    const res = await exportGet('?market_id=38');

    expect(res.status).toBe(400);
    expect(listQueries()).toHaveLength(0);
  });

  it('menejer: filial JWT dan — so‘rovdagi begona branch_id e’tiborsiz', async () => {
    total = 5;
    user = { sub: '25', roles: ['manager'], branch_id: '3' };

    const res = await exportGet('?branch_id=99');

    expect(res.status).toBe(200);
    expect(listQueries()[0].branch_id).toBe('3');
  });

  it('kuryer: faqat o‘z buyurtmalari (courier_ids = [sub])', async () => {
    total = 5;
    user = { sub: '26', roles: ['courier'] };

    await exportGet('?courier_id=99');

    expect(listQueries()[0].courier_ids).toEqual(['26']);
  });

  it.each([['customer'], ['investor'], ['logist'], ['operator']])(
    '%s → 403 (RolesGuard), order-service chaqirilmaydi',
    async (role) => {
      total = 5;
      user = { sub: '9', roles: [role] };

      const res = await exportGet();

      expect(res.status).toBe(403);
      expect(listQueries()).toHaveLength(0);
    },
  );

  it('1-sahifa xatosi — buzilgan fayl emas, oddiy HTTP xato', async () => {
    failFirstPage = true;

    const res = await exportGet();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(String(res.headers['content-type'] ?? '')).not.toContain(
      'spreadsheetml',
    );
  });
});

describe('xWsCAA5N — streamOrdersXlsx (chegara va uzilish)', () => {
  type FakeRes = PassThrough & {
    setHeader: (name: string, value: string) => void;
    headers: Record<string, string>;
  };
  const fakeRes = () => {
    const stream = new PassThrough() as FakeRes;
    stream.headers = {};
    stream.setHeader = (name: string, value: string) => {
      stream.headers[name.toLowerCase()] = value;
    };
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    return { stream, body: () => Buffer.concat(chunks) };
  };

  const pages =
    (count: number) =>
    (page: number): Promise<OrderExportPage> => {
      const all = pagedOrders(count)({ page, limit: 500, max_limit: 500 });
      return Promise.resolve({ rows: all.data, total: count });
    };

  it('⭐ TC2: chegaradan oshsa — birinchi N qator + X-Export-Truncated:true + faylda DIQQAT qatori (jimgina emas)', async () => {
    const { stream, body } = fakeRes();
    const ended = new Promise((resolve) => stream.on('end', resolve));

    const result = await streamOrdersXlsx(stream, pages(2_500), {
      maxRows: 1_000,
    });
    await ended;

    expect(result).toEqual(
      expect.objectContaining({
        status: 'completed',
        total: 2_500,
        written: 1_000,
        truncated: true,
      }),
    );
    expect(stream.headers['x-export-truncated']).toBe('true');
    expect(stream.headers['x-export-total']).toBe('2500');
    expect(stream.headers['x-export-limit']).toBe('1000');
    const rows = await readSheet(body());
    const data = rows.filter(
      (r) =>
        typeof r[col('id')] === 'string' &&
        /^\d+$/.test(r[col('id')] as string),
    );
    expect(data).toHaveLength(1_000);
    const warning = rows.find((r) => String(r[0]).startsWith('DIQQAT'));
    expect(String(warning?.[0])).toContain('2 500');
    expect(String(warning?.[0])).toContain('1 000');
  });

  it('keyingi sahifada xato — oqim uziladi (aborted), fayl "to‘liq" bo‘lib yopilmaydi', async () => {
    const { stream } = fakeRes();
    const destroyed = new Promise<Error | undefined>((resolve) =>
      stream.on('error', (err: Error) => resolve(err)),
    );
    const fetchPage = (page: number): Promise<OrderExportPage> =>
      page === 2 ? Promise.reject(new Error('timeout')) : pages(1_200)(page);

    const result = await streamOrdersXlsx(stream, fetchPage);

    expect(result.status).toBe('aborted');
    expect(result.written).toBe(500);
    expect((await destroyed)?.message).toBe('timeout');
    expect(stream.destroyed).toBe(true);
  });
});

describe('xWsCAA5N — eski GET /export/orders.xlsx 100 qatorda kesilmaydi', () => {
  it('order-service sukut chegarasi (100) — max_limit uzatiladi, 1 234 buyurtmaning hammasi faylda', async () => {
    const totalOrders = 1_234;
    const orderClient = {
      send: jest.fn((_p: unknown, payload: { query: Order }) =>
        of(pagedOrders(totalOrders)(payload.query)),
      ),
    };
    const controller = new ExcelGatewayController(
      orderClient as any,
      { send: jest.fn() } as any,
      { send: jest.fn() } as any,
    );
    let buffer: Buffer = Buffer.alloc(0);
    const res = {
      set: jest.fn(),
      end: jest.fn((buf: Buffer) => {
        buffer = buf;
      }),
    };

    await controller.exportOrders(
      res as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { user: { sub: '1', roles: ['superadmin'] } },
    );

    const rows = await readSheet(buffer);
    expect(rows).toHaveLength(1 + totalOrders);
    const firstCall = orderClient.send.mock.calls[0] as unknown as [
      unknown,
      { query: Order },
    ];
    expect(firstCall[1].query.max_limit).toBe(500);
  });
});
