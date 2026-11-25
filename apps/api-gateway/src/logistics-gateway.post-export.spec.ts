import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { Workbook } from 'exceljs';
import { sheetOrderProblems } from '@app/report-kit/testing/sheet-order';
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

/** Katak → oddiy qiymat: formula — natijasi, DIQQAT (richText) — matni. */
const plain = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const cell = value as {
      formula?: string;
      result?: unknown;
      richText?: Array<{ text: string }>;
    };
    if (cell.richText) return cell.richText.map((part) => part.text).join('');
    if (cell.formula) return cell.result ?? 0;
  }
  return value;
};

const loadBook = async (buffer: Buffer) => {
  const wb = new Workbook();
  // Excel «Repaired» qilmasin (exceljs o'qiganda sezmaydi).
  expect(sheetOrderProblems(buffer)).toEqual([]);
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
};

const sheetRows = (wb: Workbook, name: string): unknown[][] => {
  const rows: unknown[][] = [];
  wb.getWorksheet(name)!.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values as unknown[]).slice(2).map(plain));
  });
  return rows;
};

/** «Buyurtmalar» varag'i sarlavhadan boshlab (banner va kartalarsiz). */
const readSheet = async (buffer: Buffer) => {
  const rows = sheetRows(await loadBook(buffer), 'Buyurtmalar');
  return rows.slice(rows.findIndex((row) => row[0] === '№'));
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

  it('ustunlar: buyurtma eksporti + 4 ta pochta ustuni; qiymatlar va «JAMI»', async () => {
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
    expect(at(current, 'Buyurtma ID')).toBe(10);
    expect(at(current, "Narxi, so'm")).toBe(100000);
    expect(at(current, 'Firma')).toBe('TEST Market');
    expect(at(current, 'Tuman')).toBe('Asaka');
    // Buyurtma qatorida kuryer yo'q — pochta kuryeri.
    expect(at(current, 'Kuryer')).toBe(`Ali ${XSS}`);
    // Haqiqiy Excel sanasi (Toshkent soati).
    expect(at(current, 'Pochtaga kirgan')).toEqual(
      new Date('2026-10-19T10:00:00.000Z'),
    );
    expect(at(current, 'Pochtadan chiqqan')).toBe('—');
    expect(at(current, 'Hozir pochtada')).toBe('ha');
    expect(at(current, 'Hozirgi holat')).toBe('Qabul qilindi · shu pochtada');

    expect(at(former, 'Buyurtma ID')).toBe(11);
    expect(at(former, 'Pochtaga kirgan')).toEqual(
      new Date('2026-10-19T11:00:00.000Z'),
    );
    expect(at(former, 'Pochtadan chiqqan')).toEqual(
      new Date('2026-10-20T12:00:00.000Z'),
    );
    expect(at(former, 'Hozir pochtada')).toBe("yo'q");
    expect(at(former, 'Hozirgi holat')).toBe('Sotilgan · pochta #77');

    expect(at(total, '№')).toBe('JAMI');
    expect(at(total, "Narxi, so'm")).toBe(250000);
    expect(at(total, 'Mahsulot')).toBe(2);
    expect(at(total, 'Hozir pochtada')).toBe(1);
    expect(rows).toHaveLength(4);

    expect(headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(headers['content-disposition']).toMatch(
      /^attachment; filename="pochta-55-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(headers['cache-control']).toBe('no-store');
  });

  it('JAMI filtrga moslashadi (SUBTOTAL), sonlar banner ostida, chiqib ketgan buyurtma xira', async () => {
    const { controller } = build();
    const { res, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx('55', req(['manager']), res as never);
    const wb = await loadBook(await body());
    const ws = wb.getWorksheet('Buyurtmalar')!;
    expect(ws.getCell('B2').value).toBe("Pochta №55 — buyurtmalar ro'yxati");
    expect(ws.getCell('B3').value).toBe(
      `Pochtaga har qachon kirgan buyurtmalar · Kuryer: Ali ${XSS}`,
    );
    // Kartalar: jami 2, hozir 1, chiqqan 1.
    const kpis = sheetRows(wb, 'Buyurtmalar').find(
      (row) => row.filter((cell) => cell === 1).length > 1,
    );
    expect(kpis).toEqual(expect.arrayContaining([2, 1]));
    expect(ws.getCell('G12').formula).toBe('SUBTOTAL(2,B10:B11)');
    expect(ws.getCell('J12').formula).toBe('SUBTOTAL(9,J10:J11)');
    expect(ws.getCell('P12').formula).toBe('COUNTIF(P10:P11,"ha")');
    expect(ws.autoFilter).toBe('B9:Q11');
    // Hozir pochtadagi — oddiy matn, chiqib ketgani — xira.
    expect(ws.getCell('C10').font.color?.argb).toBe('FF101733');
    expect(ws.getCell('C11').font.color?.argb).toBe('FF7C859F');
  });

  it('«Xulosa»: hozir pochtada / chiqqan summasi, holat va joy bo‘yicha', async () => {
    const { controller } = build();
    const { res, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx('55', req(['admin']), res as never);
    const rows = sheetRows(await loadBook(await body()), 'Xulosa');
    expect(rows).toContainEqual(
      expect.arrayContaining([250000, 100000, 150000]),
    );
    const named = (name: string) => rows.find((row) => row[0] === name)!;
    expect(named('Qabul qilindi')).toEqual(
      expect.arrayContaining([1, 0.5, 100000]),
    );
    expect(named('Sotilgan')).toEqual(expect.arrayContaining([1, 150000]));
    expect(named('Shu pochtada')).toEqual(expect.arrayContaining([1, 100000]));
    expect(named('Pochta #77')).toEqual(expect.arrayContaining([1, 150000]));
    expect(named('TEST Market')).toEqual(expect.arrayContaining([2, 250000]));
  });

  it('LOGIST: «Narxi» ustuni ham, hech qanday summa ham yo‘q («Xulosa» da ham)', async () => {
    const { controller } = build();
    const { res, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx(
      '55',
      req(['logist'], '42', null),
      res as never,
    );
    const wb = await loadBook(await body());
    const rows = sheetRows(wb, 'Buyurtmalar');
    const header = rows.find((row) => row[0] === '№') as string[];
    expect(header.join('|')).not.toMatch(/narx|summa|so'm/i);
    expect(header.slice(-4)).toEqual([
      'Pochtaga kirgan',
      'Pochtadan chiqqan',
      'Hozir pochtada',
      'Hozirgi holat',
    ]);
    expect(rows[rows.length - 1][0]).toBe('JAMI');
    // Ikkala varaqda: narxlar, ularning istalgan yig'indisi va «so'm» yo'q.
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      'Buyurtmalar',
      'Xulosa',
    ]);
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const value = plain(cell.value);
          if (typeof value === 'number') expect(value).toBeLessThan(1000);
          if (typeof value === 'string') {
            expect(value).not.toMatch(/so['‘’`]m|narx|summa|tarif/i);
            expect(value).not.toMatch(/100 ?000|150 ?000|250 ?000/);
          }
        });
      });
    }
    // «Xulosa» jadvallari: nom, soni, ulushi, chiziq — summa ustunisiz.
    const summary = sheetRows(wb, 'Xulosa');
    const head = summary.find((row) => row[0] === 'Holati')!;
    expect(head.filter(Boolean)).toEqual(
      expect.arrayContaining(['Holati', 'Soni', 'Ulushi']),
    );
    expect(summary).toContainEqual(expect.arrayContaining([2, 1]));
  });

  it('tarix olinmagan (history_incomplete) — DIQQAT tepada va «Xulosa» da, «chiqqan» — «—»', async () => {
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
    const wb = await loadBook(await body());
    const rows = sheetRows(wb, 'Buyurtmalar');
    const warning = rows.findIndex((row) =>
      /^DIQQAT: pochta tarixi/.test(String(row[0])),
    );
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(rows.findIndex((row) => row[0] === '№'));
    const ws = wb.getWorksheet('Buyurtmalar')!;
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 11 });
    // «Pochtadan chiqqan» soni noma'lum — «—» (0 emas).
    expect(rows.find((row) => row.includes('—') && row[0] === 1)).toBeDefined();
    const summary = sheetRows(wb, 'Xulosa');
    expect(
      summary.some((row) => /^DIQQAT: pochta tarixi/.test(String(row[0]))),
    ).toBe(true);
    expect(summary.some((row) => row.includes("tarix to'liq emas"))).toBe(true);
  });

  it('bo‘sh pochta — fayl ochiladi, JAMI 0', async () => {
    const logistics = jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'logistics.post.orders_by_post'
        ? of(ordersByPostResponse({ allOrdersByPostId: [] }))
        : of({ data: null }),
    );
    const { controller } = build({ logistics });
    const { res, body } = fakeXlsxResponse();
    await controller.exportPostOrdersXlsx('55', req(['admin']), res as never);
    const rows = await readSheet(await body());
    expect(rows.some((row) => row[0] === "Pochtada buyurtma yo'q")).toBe(true);
    const total = rows.find((row) => row[0] === 'JAMI')!;
    expect(total.filter((cell) => cell === 0)).toHaveLength(3);
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
