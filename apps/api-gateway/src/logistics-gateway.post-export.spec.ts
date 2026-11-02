import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { Workbook } from 'exceljs';
import { PassThrough } from 'node:stream';
import { NEVER, of, throwError, TimeoutError } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import {
  isPureCourierRequester,
  LogisticsGatewayController,
  POST_EXPORT_TIMEOUT_MS,
  parsePostOrdersView,
  parsePostReceiptFormat,
} from './logistics-gateway.controller';
import { ORDER_EXPORT_COLUMNS } from './order-export/orders-xlsx.export';
import {
  POST_ORDER_EXPORT_EXTRA_COLUMNS,
  postOrdersXlsxFileName,
} from './order-export/post-orders-xlsx.export';
import { renderPostReceiptHtml } from './printer/printer.util';

/**
 * Eski pochtalar — `GET /post/:id/orders.xlsx`, `GET /post/:id/receipt` va
 * `GET /post/orders/:id?view=`.
 *
 * Ega: «Eski pochtalar bo'sh, yorlig'ini ham, buyurtmalar Excel ro'yxatini
 * ham olib bo'lmaydi». Qarorlar: (1) eski pochta — pochtaga HAR QACHON kirgan
 * buyurtmalar, «hozir qayerda» bilan; (2) «Yorliq» — POCHTA CHEKI; (3) Excel
 * va chek — xodimlar, LOGIST (pulsiz), COURIER (o'z pochtasi); market/mijoz —
 * yo'q. Doira logistics'da — gateway so'rovchini va `view: 'all'` ni uzatadi.
 */

const XSS = '<script>alert(1)</script>';

const currentRow = {
  id: '10',
  market_id: '2',
  customer_id: '3',
  district_id: '4',
  region_id: '5',
  status: 'received',
  total_price: 100000,
  market_tariff: 20000,
  where_deliver: 'address',
  address: "Navoiy ko'chasi 5",
  post_id: '55',
  canceled_post_id: null,
  in_post_now: true,
  membership: {
    joined_at: '2026-10-19T05:00:00.000Z',
    left_at: null,
    next_post_id: null,
  },
  current_post_id: '55',
  current_canceled_post_id: null,
  items: [{ id: '501', product_id: '700', quantity: 1 }],
};

const formerRow = {
  id: '11',
  market_id: '2',
  customer_id: '33',
  district_id: '4',
  region_id: '5',
  status: 'sold',
  total_price: 150000,
  market_tariff: 20000,
  where_deliver: 'center',
  post_id: '77',
  canceled_post_id: null,
  in_post_now: false,
  membership: {
    joined_at: '2026-10-19T06:00:00.000Z',
    left_at: '2026-10-20T07:00:00.000Z',
    next_post_id: '77',
  },
  current_post_id: '77',
  current_canceled_post_id: null,
  items: [],
};

const postMeta = {
  id: '55',
  status: 'received',
  courier_id: '26',
  courier: { id: '26', name: `Ali ${XSS}`, phone_number: '998901234567' },
  qr_code_token: 'POST-abc123',
  order_quantity: 1,
  branch_id: '15',
  branch: { id: '15', name: 'Andijon filiali' },
  region_id: '5',
  region: { id: '5', name: 'Andijon' },
  createdAt: '2026-10-19T04:30:00.000Z',
};

const ordersByPostResponse = (overrides: Record<string, unknown> = {}) => ({
  statusCode: 200,
  data: {
    allOrdersByPostId: [currentRow, formerRow],
    homeOrders: { homeOrders: 1, homeOrdersTotalPrice: 100000 },
    centerOrders: { centerOrders: 1, centerOrdersTotalPrice: 150000 },
    view: 'all',
    history_incomplete: false,
    post: postMeta,
    ...overrides,
  },
});

type Send = jest.Mock;

const build = (options: { logistics?: Send } = {}) => {
  const logistics = {
    send:
      options.logistics ??
      jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
        if (pattern.cmd === 'logistics.post.orders_by_post') {
          return of(ordersByPostResponse());
        }
        if (pattern.cmd === 'logistics.district.find_by_id') {
          return of({
            data: {
              id: payload.id,
              name: 'Asaka',
              region: { id: '5', name: 'Andijon' },
            },
          });
        }
        return of({ statusCode: 200, data: null });
      }),
  };
  const identity = {
    send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
      if (pattern.cmd === 'identity.customer.find_by_id') {
        return of({
          data: {
            id: payload.id,
            name: payload.id === '3' ? `Vali ${XSS}` : 'Sobir',
            phone_number: '998907778899',
            salary: 1,
          },
        });
      }
      if (pattern.cmd === 'identity.market.find_by_id') {
        return of({ data: { id: payload.id, name: 'TEST Market' } });
      }
      return of({ data: null });
    }),
  };
  const controller = new LogisticsGatewayController(
    logistics as never,
    identity as never,
  );
  return { controller, logistics };
};

const req = (roles: string[], sub = '20', branchId: string | null = '15') => ({
  user: { sub, roles, branch_id: branchId },
});

const payloadOf = (client: { send: Send }, cmd: string) => {
  const call = (client.send.mock.calls as unknown[][]).find(
    (args) => (args[0] as { cmd?: string }).cmd === cmd,
  );
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
};

/** exceljs stream yozuvchisi uchun soxta Express javobi. */
const fakeXlsxResponse = () => {
  const stream = new PassThrough();
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const res = Object.assign(stream, {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    },
  });
  const body = async () => {
    if (!stream.readableEnded) {
      await new Promise((resolve) => stream.on('end', resolve));
    }
    return Buffer.concat(chunks);
  };
  return { res, headers, body };
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

const fakeHtmlResponse = () => {
  const res = { set: jest.fn(), end: jest.fn() };
  return {
    res,
    html: (): string => {
      const body = (res.end.mock.calls as unknown[][])[0]?.[0];
      return typeof body === 'string' ? body : '';
    },
  };
};

describe('Eski pochta eksporti — @Roles (ega qarori 3)', () => {
  const rolesOf = (method: keyof LogisticsGatewayController) =>
    Reflect.getMetadata(
      ROLES_KEY,
      Object.getOwnPropertyDescriptor(
        LogisticsGatewayController.prototype,
        method,
      )?.value as object,
    ) as string[];

  it.each(['exportPostOrdersXlsx', 'getPostReceipt'] as const)(
    '%s: xodimlar + logist + kuryer; market/operator/mijoz yo‘q',
    (method) => {
      const roles = rolesOf(method);
      expect([...roles].sort()).toEqual(
        [
          'superadmin',
          'admin',
          'branch',
          'manager',
          'registrator',
          'courier',
          'logist',
        ].sort(),
      );
      for (const denied of ['market', 'market_operator', 'customer']) {
        expect(roles).not.toContain(denied);
      }
    },
  );
});

describe('GET /post/orders/:id?view= — passthrough', () => {
  it('view berilmasa — payload’da view yo‘q (logistics sukuti)', async () => {
    const { controller, logistics } = build();
    await controller.getOrdersByPost('55', req(['manager']));
    expect(
      payloadOf(logistics, 'logistics.post.orders_by_post'),
    ).not.toHaveProperty('view');
  });

  it.each([
    ['all', 'all'],
    [' ALL ', 'all'],
    ['current', 'current'],
  ])('view=%p — logistics’ga %p', async (raw, expected) => {
    const { controller, logistics } = build();
    await controller.getOrdersByPost('55', req(['manager']), raw);
    expect(payloadOf(logistics, 'logistics.post.orders_by_post')).toEqual(
      expect.objectContaining({
        id: '55',
        view: expected,
        requester: { id: '20', roles: ['manager'], branch_id: '15' },
      }),
    );
  });

  it('noma’lum view — 400, logistics chaqirilmaydi', () => {
    const { controller, logistics } = build();
    expect(() =>
      controller.getOrdersByPost('55', req(['manager']), 'history'),
    ).toThrow(BadRequestException);
    expect(logistics.send).not.toHaveBeenCalled();
  });

  it('parsePostOrdersView: bo‘sh — undefined, massiv — 400', () => {
    expect(parsePostOrdersView(undefined)).toBeUndefined();
    expect(parsePostOrdersView('  ')).toBeUndefined();
    expect(() => parsePostOrdersView(['all', 'current'])).toThrow(
      BadRequestException,
    );
  });
});

describe('GET /post/:id/orders.xlsx', () => {
  it('logistics’ga view: all + so‘rovchi (doira logistics’da) + with_sender_branch', async () => {
    const { controller, logistics } = build();
    const { res, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx(
      '55',
      req(['courier'], '26', null),
      res as never,
    );
    await body();
    expect(payloadOf(logistics, 'logistics.post.orders_by_post')).toEqual({
      id: '55',
      requester: { id: '26', roles: ['courier'], branch_id: null },
      with_sender_branch: true,
      view: 'all',
    });
  });

  it('ustunlar: buyurtma eksporti + 4 ta pochta ustuni; qiymatlar va «Jami»', async () => {
    const { controller } = build();
    const { res, headers, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx('55', req(['manager']), res as never);
    const rows = await readSheet(await body());
    const header = rows[0] as string[];
    expect(header).toEqual([
      ...ORDER_EXPORT_COLUMNS.map((c) => c.header),
      'Pochtaga kirgan',
      'Pochtadan chiqqan',
      'Hozir pochtada',
      'Hozirgi holat',
    ]);
    expect(POST_ORDER_EXPORT_EXTRA_COLUMNS.map((c) => c.header)).toEqual(
      header.slice(-4),
    );
    const at = (row: unknown[], name: string) => row[header.indexOf(name)];

    const [current, former, total] = rows.slice(1);
    expect(at(current, 'Buyurtma ID')).toBe('10');
    expect(at(current, 'Narxi')).toBe(100000);
    expect(at(current, 'Firma')).toBe('TEST Market');
    expect(at(current, 'Tuman')).toBe('Asaka');
    // Buyurtma qatorida kuryer yo'q — pochta kuryeri.
    expect(at(current, 'Kuryer')).toBe(`Ali ${XSS}`);
    expect(at(current, 'Pochtaga kirgan')).toBe('2026-10-19 10:00');
    expect(at(current, 'Pochtadan chiqqan')).toBeUndefined();
    expect(at(current, 'Hozir pochtada')).toBe('ha');
    expect(at(current, 'Hozirgi holat')).toBe('Qabul qilindi · shu pochtada');

    expect(at(former, 'Buyurtma ID')).toBe('11');
    expect(at(former, 'Pochtaga kirgan')).toBe('2026-10-19 11:00');
    expect(at(former, 'Pochtadan chiqqan')).toBe('2026-10-20 12:00');
    expect(at(former, 'Hozir pochtada')).toBe("yo'q");
    expect(at(former, 'Hozirgi holat')).toBe('Sotilgan · pochta #77');

    expect(at(total, 'N')).toBe('Jami');
    expect(at(total, 'Narxi')).toBe(250000);
    expect(at(total, 'Mahsulot')).toBe('2 ta buyurtma');
    expect(at(total, 'Hozir pochtada')).toBe('1 ta');
    expect(rows).toHaveLength(4);

    expect(headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(headers['content-disposition']).toMatch(
      /^attachment; filename="pochta-55-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(headers['cache-control']).toBe('no-store');
  });

  it('LOGIST: «Narxi» ustuni ham, jami summa ham yo‘q', async () => {
    const { controller } = build();
    const { res, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx(
      '55',
      req(['logist'], '42', null),
      res as never,
    );
    const rows = await readSheet(await body());
    const header = rows[0] as string[];
    expect(header).not.toContain('Narxi');
    expect(header.slice(-4)).toEqual([
      'Pochtaga kirgan',
      'Pochtadan chiqqan',
      'Hozir pochtada',
      'Hozirgi holat',
    ]);
    const cells = rows.flat();
    expect(cells).not.toContain(100000);
    expect(cells).not.toContain(150000);
    expect(cells).not.toContain(250000);
    expect(rows[rows.length - 1][0]).toBe('Jami');
  });

  it('tarix olinmagan (history_incomplete) — faylda DIQQAT qatori', async () => {
    const logistics = jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'logistics.post.orders_by_post'
        ? of(
            ordersByPostResponse({
              allOrdersByPostId: [currentRow],
              history_incomplete: true,
            }),
          )
        : of({ data: null }),
    );
    const { controller } = build({ logistics });
    const { res, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx('55', req(['admin']), res as never);
    const rows = await readSheet(await body());
    expect(String(rows[rows.length - 1][0])).toMatch(/^DIQQAT: pochta tarixi/);
  });

  it('fayl nomi: pochta-<id>-<Toshkent kuni>.xlsx', () => {
    expect(
      postOrdersXlsxFileName('55', new Date('2026-10-31T20:30:00.000Z')),
    ).toBe('pochta-55-2026-11-01.xlsx');
  });
});

describe('GET /post/:id/receipt', () => {
  it('logistics’ga view: all + so‘rovchi; 80mm sukut; QR/kuryer/soni/summa', async () => {
    const { controller, logistics } = build();
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt('55', req(['manager']), res as never);
    expect(payloadOf(logistics, 'logistics.post.orders_by_post')).toEqual({
      id: '55',
      requester: { id: '20', roles: ['manager'], branch_id: '15' },
      with_sender_branch: true,
      view: 'all',
    });
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const page = html();
    expect(page).toContain('size:80mm auto');
    expect(page).toMatch(/<img class="qr" src="data:image\/png;base64,/);
    expect(page).toContain('POST-abc123');
    expect(page).toContain('#55');
    expect(page).toContain('+998 (90) 123-45-67');
    expect(page).toContain('Andijon filiali');
    expect(page).toContain('2 ta (hozir pochtada: 1 ta)');
    expect(page).toContain("250,000 so'm");
    expect(page).toContain('EL-');
    expect(page).toContain('Qabul qilindi');
    expect(page).toContain("yo'q (pochta #77)");
  });

  it('ism/kuryerdagi HTML escape qilinadi', async () => {
    const { controller } = build();
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt('55', req(['admin']), res as never, 'a4');
    const page = html();
    expect(page).toContain('size:A4');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('Ali &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('Vali &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('LOGIST: summa ustuni ham, jami summa ham yo‘q', async () => {
    const { controller } = build();
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt(
      '55',
      req(['logist'], '42', null),
      res as never,
      'a4',
    );
    const page = html();
    expect(page).not.toContain('Jami summa');
    expect(page).not.toContain('<th>Summa</th>');
    expect(page).not.toContain("so'm");
    expect(page).toContain('2 ta (hozir pochtada: 1 ta)');
  });

  it('noma’lum format — 400, logistics chaqirilmaydi', async () => {
    const { controller, logistics } = build();
    const { res } = fakeHtmlResponse();
    await expect(
      controller.getPostReceipt('55', req(['admin']), res as never, 'pdf'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(logistics.send).not.toHaveBeenCalled();
    expect(parsePostReceiptFormat(undefined)).toBe('80mm');
    expect(parsePostReceiptFormat(' A4 ')).toBe('a4');
  });

  it('renderPostReceiptHtml: bo‘sh pochta — «Buyurtmalar yo‘q», QR’siz ham chiqadi', async () => {
    const page = await renderPostReceiptHtml({ id: '9' }, [], '80mm');
    expect(page).toContain("Buyurtmalar yo'q");
    expect(page).toContain('0 ta (hozir pochtada: 0 ta)');
    expect(page).not.toContain('<img class="qr"');
  });
});

describe('Eski pochta eksporti — logistics kutish vaqti chegaralangan', () => {
  afterEach(() => jest.useRealTimers());

  it('logistics javob bermasa — 504 (POST_EXPORT_TIMEOUT_MS)', async () => {
    jest.useFakeTimers();
    const { controller } = build({ logistics: jest.fn(() => NEVER) });
    const { res } = fakeHtmlResponse();
    const pending = controller.getPostReceipt(
      '55',
      req(['admin']),
      res as never,
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    await jest.advanceTimersByTimeAsync(POST_EXPORT_TIMEOUT_MS + 1);
    await assertion;
    expect(res.end).not.toHaveBeenCalled();
  });

  it('TimeoutError — 504; boshqa xato o‘zgarmasdan o‘tadi (403)', async () => {
    const timeoutBuild = build({
      logistics: jest.fn(() => throwError(() => new TimeoutError())),
    });
    const { res } = fakeXlsxResponse();
    await expect(
      timeoutBuild.controller.exportPostOrdersXlsx(
        '55',
        req(['admin']),
        res as never,
      ),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);

    const forbidden = { statusCode: 403, message: 'Forbidden' };
    const forbiddenBuild = build({
      logistics: jest.fn(() => throwError(() => forbidden)),
    });
    await expect(
      forbiddenBuild.controller.exportPostOrdersXlsx(
        '55',
        req(['branch']),
        fakeXlsxResponse().res as never,
      ),
    ).rejects.toBe(forbidden);
  });
});

describe('Eski pochta eksporti — kuryer faqat o‘z pochtasi (ega qarori 3)', () => {
  // Logistics sof kuryerni boshqa kuryer pochtasidan to'xtatadi, lekin
  // kuryersiz pochtani (filial o'tkazmasi) filial doirasi bo'yicha ochadi.
  const withPost = (post: Record<string, unknown> | null) =>
    jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'logistics.post.orders_by_post'
        ? of(ordersByPostResponse({ post }))
        : of({ data: null }),
    );

  it.each([
    ['kuryersiz (null)', { ...postMeta, courier_id: null, courier: null }],
    ["kuryersiz ('0')", { ...postMeta, courier_id: '0', courier: null }],
    ['boshqa kuryer', { ...postMeta, courier_id: '99' }],
    ['pochta meta’si yo‘q', null],
  ])('%s — Excel ham, chek ham 403', async (_label, post) => {
    const { controller } = build({ logistics: withPost(post) });
    const xlsx = fakeXlsxResponse();
    await expect(
      controller.exportPostOrdersXlsx(
        '100',
        req(['courier'], '26', '15'),
        xlsx.res as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const receipt = fakeHtmlResponse();
    await expect(
      controller.getPostReceipt(
        '100',
        req(['courier'], '26', '15'),
        receipt.res as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(receipt.res.end).not.toHaveBeenCalled();
  });

  it('o‘z pochtasi — chek chiqadi', async () => {
    const { controller } = build();
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt(
      '55',
      req(['courier'], '26', '15'),
      res as never,
    );
    expect(html()).toContain('POST-abc123');
  });

  it('xodim rolli kuryer (menejer + kuryer) — kuryersiz pochta ham ochiladi', async () => {
    const { controller } = build({
      logistics: withPost({ ...postMeta, courier_id: null, courier: null }),
    });
    const { res, html } = fakeHtmlResponse();
    await controller.getPostReceipt(
      '55',
      req(['courier', 'manager'], '26', '15'),
      res as never,
    );
    expect(html()).toContain('POST-abc123');
  });

  it('isPureCourierRequester: rollar normallashtiriladi', () => {
    expect(isPureCourierRequester([' COURIER '])).toBe(true);
    expect(isPureCourierRequester(['courier', 'logist'])).toBe(true);
    expect(isPureCourierRequester(['courier', 'registrator'])).toBe(false);
    expect(isPureCourierRequester(['manager'])).toBe(false);
    expect(isPureCourierRequester(undefined)).toBe(false);
  });
});

describe('GET /post/orders/:id — kutish vaqti view bo‘yicha', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    ['berilmagan (qabul qilingan pochta sukuti — all)', undefined],
    ['all', 'all'],
  ])(
    'view %s — 8 s da uzilmaydi, POST_EXPORT_TIMEOUT_MS da uziladi',
    async (_label, view) => {
      jest.useFakeTimers();
      const { controller } = build({ logistics: jest.fn(() => NEVER) });
      let settled = false;
      const pending = controller
        .getOrdersByPost('55', req(['manager']), view)
        .finally(() => {
          settled = true;
        });
      const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
      await jest.advanceTimersByTimeAsync(8001);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(POST_EXPORT_TIMEOUT_MS - 8000);
      await assertion;
    },
  );

  it('view=current — avvalgidek 8 s', async () => {
    jest.useFakeTimers();
    const { controller } = build({ logistics: jest.fn(() => NEVER) });
    const pending = controller.getOrdersByPost(
      '55',
      req(['manager']),
      'current',
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await jest.advanceTimersByTimeAsync(8001);
    await assertion;
  });
});
