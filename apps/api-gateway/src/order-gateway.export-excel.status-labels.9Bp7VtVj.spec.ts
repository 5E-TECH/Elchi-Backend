import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Order_status } from '@app/common';
import { Workbook } from 'exceljs';
import { PassThrough } from 'node:stream';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { OrderGatewayController } from './order-gateway.controller';
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_STATUS_LABELS,
  ORDER_EXPORT_UNKNOWN_STATUS_LABEL,
  orderExportStatusLabel,
  streamOrdersXlsx,
  toOrderExportRow,
} from './order-export/orders-xlsx.export';

/**
 * 9Bp7VtVj — Excel eksportidagi («Holati» ustuni) holat nomlari EKRANDAGI
 * nomlar bilan AYNAN bir xil.
 *
 * Tester (2026-10-25, market 37): faylda 'Marketga qaytarildi' (ekranda
 * «Marketga topshirildi»), 'Qisman to'landi' («Qisman to'langan»), created
 * 'Qabul qilingan' («Yaratilgan»), waiting_customer 'Kutilmoqda' («Mijoz
 * kutilmoqda»), closed 'Yopildi' («Yopilgan»), cancelled (sent) 'Bekor
 * qilingan' («Bekor — jo'natilgan»).
 *
 * Haqiqat manbai — Elchi-Frontend (origin/dev):
 *   - `src/entities/order/model/statusRegistry.ts` → `ORDER_STATUS_REGISTRY`
 *     (backend holati → `labelKey: order.<key>`);
 *   - `src/locales/uz/status.json` → `order.*` (badge va filtr yorliqlari).
 * Quyidagi jadval o'sha faylning AYNAN nusxasi: FE yorlig'i o'zgarsa, shu
 * spec va `ORDER_EXPORT_STATUS_LABELS` birga yangilanadi.
 */

/** [backend holati, FE `status.json` kaliti, uz yorliq] — 13 ta holat. */
const FE_UZ_STATUS_LABELS: ReadonlyArray<
  readonly [Order_status, string, string]
> = [
  [Order_status.NEW, 'order.new', 'Yangi'],
  [Order_status.CREATED, 'order.created', 'Yaratilgan'],
  [Order_status.RECEIVED, 'order.received', 'Qabul qilindi'],
  [Order_status.ON_THE_ROAD, 'order.on_the_road', "Yo'lda"],
  [Order_status.WAITING, 'order.waiting', 'Kutilmoqda'],
  [Order_status.WAITING_CUSTOMER, 'order.waiting_customer', 'Mijoz kutilmoqda'],
  [Order_status.PARTLY_PAID, 'order.partly_paid', "Qisman to'langan"],
  [Order_status.SOLD, 'order.sold', 'Sotilgan'],
  [Order_status.PAID, 'order.paid', "To'langan"],
  [Order_status.CANCELLED, 'order.cancelled', 'Bekor qilingan'],
  [Order_status.CANCELLED_SENT, 'order.cancelled_sent', "Bekor — jo'natilgan"],
  [
    Order_status.RETURNED_TO_MARKET,
    'order.returned_to_market',
    'Marketga topshirildi',
  ],
  [Order_status.CLOSED, 'order.closed', 'Yopilgan'],
];

type Order = Record<string, unknown>;

const col = (key: string) =>
  ORDER_EXPORT_COLUMNS.findIndex((c) => c.key === key);

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

const cellText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** «Holati» ustuni: buyurtma id → yorliq (sarlavha va «Jami» qatorisiz). */
const statusById = (rows: unknown[][]) =>
  new Map(
    rows
      .slice(1)
      .filter((r) => /^\d+$/.test(cellText(r[col('id')])))
      .map((r) => [cellText(r[col('id')]), r[col('status')]] as const),
  );

const order = (id: number, extra: Order): Order => ({
  id: String(id),
  total_price: 1000,
  createdAt: '2026-10-25T05:00:00.000Z',
  market: { id: '37', name: 'TEST Market' },
  customer: { id: '153', name: 'Ali', phone_number: '+998901112233' },
  ...extra,
});

describe('9Bp7VtVj — eksport holat yorliqlari = ekran (FE status.json uz)', () => {
  it('backend’ning HAR BIR holati uchun yorliq bor va u FE `order.*` bilan AYNAN', () => {
    expect(Object.keys(ORDER_EXPORT_STATUS_LABELS).sort()).toEqual(
      Object.values(Order_status).sort(),
    );
    expect(FE_UZ_STATUS_LABELS.map(([s]) => s).sort()).toEqual(
      Object.values(Order_status).sort(),
    );
    expect(ORDER_EXPORT_STATUS_LABELS).toEqual(
      Object.fromEntries(FE_UZ_STATUS_LABELS.map(([s, , label]) => [s, label])),
    );
    expect(ORDER_EXPORT_UNKNOWN_STATUS_LABEL).toBe("Noma'lum"); // order.unknown
  });

  it.each(FE_UZ_STATUS_LABELS)('%s → %s «%s»', (status, _feKey, label) => {
    expect(orderExportStatusLabel({ status })).toBe(label);
    expect(toOrderExportRow({ id: '1', status }, 1).status).toBe(label);
  });

  it('ikki holat bir xil nom olmaydi (created «Yaratilgan» ≠ received «Qabul qilindi»)', () => {
    const labels = Object.values(ORDER_EXPORT_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(ORDER_EXPORT_STATUS_LABELS[Order_status.CREATED]).not.toBe(
      ORDER_EXPORT_STATUS_LABELS[Order_status.RECEIVED],
    );
  });

  it('tester topgan eski nomlar faylda qolmaydi', () => {
    const labels = Object.values(ORDER_EXPORT_STATUS_LABELS);
    for (const old of [
      'Qabul qilingan',
      'Marketga qaytarildi',
      "Qisman to'landi",
      'Yopildi',
    ]) {
      expect(labels).not.toContain(old);
    }
    expect(ORDER_EXPORT_STATUS_LABELS[Order_status.WAITING_CUSTOMER]).not.toBe(
      ORDER_EXPORT_STATUS_LABELS[Order_status.WAITING],
    );
    expect(ORDER_EXPORT_STATUS_LABELS[Order_status.CANCELLED_SENT]).not.toBe(
      ORDER_EXPORT_STATUS_LABELS[Order_status.CANCELLED],
    );
  });

  it('ro‘yxat qatori: `cancelled` + transport_status `cancelled (sent)` → «Bekor — jo‘natilgan» (FE getDisplayStatus)', () => {
    expect(
      orderExportStatusLabel({
        status: 'cancelled',
        transport_status: 'cancelled (sent)',
      }),
    ).toBe("Bekor — jo'natilgan");
    expect(
      orderExportStatusLabel({
        status: 'cancelled',
        transportStatus: 'cancelled_sent',
      }),
    ).toBe("Bekor — jo'natilgan");
    expect(
      orderExportStatusLabel({ status: 'cancelled', transport_status: null }),
    ).toBe('Bekor qilingan');
  });

  it('boshqa yozilishlar FE normalizeOrderStatus kabi tushuniladi', () => {
    const cases: Array<[string, string]> = [
      ['on_the_road', "Yo'lda"],
      ['ON_THE_ROAD', "Yo'lda"],
      ['onTheRoad', "Yo'lda"],
      ['cancelled_sent', "Bekor — jo'natilgan"],
      ['canceled (sent)', "Bekor — jo'natilgan"],
      ['partly paid', "Qisman to'langan"],
      ['waitingCustomer', 'Mijoz kutilmoqda'],
      ['  RETURNED_TO_MARKET ', 'Marketga topshirildi'],
    ];
    for (const [raw, label] of cases) {
      expect(orderExportStatusLabel({ status: raw })).toBe(label);
    }
  });

  it('noma’lum holat — o‘qiladigan xom qiymat, bo‘sh — «Noma’lum» (FE humanizeOrderStatus)', () => {
    expect(orderExportStatusLabel({ status: 'lost_in_transit' })).toBe(
      'Lost in transit',
    );
    expect(orderExportStatusLabel({ status: '' })).toBe("Noma'lum");
    expect(orderExportStatusLabel({})).toBe("Noma'lum");
    expect(toOrderExportRow({ id: '1', status: null }, 1).status).toBe(
      "Noma'lum",
    );
  });

  it('⭐ TC: .xlsx faylining «Holati» ustunida 13 holatning hammasi ekrandagi nom bilan', async () => {
    const stream = new PassThrough() as PassThrough & {
      setHeader: (name: string, value: string) => void;
    };
    stream.setHeader = () => undefined;
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise((resolve) => stream.on('end', resolve));
    const rows = FE_UZ_STATUS_LABELS.map(([status], i) =>
      order(i + 1, { status }),
    );

    const result = await streamOrdersXlsx(stream, () =>
      Promise.resolve({ rows, total: rows.length }),
    );
    await ended;

    expect(result.status).toBe('completed');
    const byId = statusById(await readSheet(Buffer.concat(chunks)));
    expect(byId.size).toBe(FE_UZ_STATUS_LABELS.length);
    FE_UZ_STATUS_LABELS.forEach(([, , label], i) => {
      expect(byId.get(String(i + 1))).toBe(label);
    });
  });
});

describe('9Bp7VtVj — GET /orders/export/excel (market 37): «Holati» = ekran', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: noop },
        { provide: 'LOGISTICS', useValue: noop },
        {
          provide: 'BRANCH',
          useValue: { send: jest.fn(() => of({ data: null })) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '37',
            roles: ['market'],
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

  it('order-service xom holatlari (jumladan `cancelled (sent)`) faylda ekrandagi nom bilan', async () => {
    // order-service xom holat qaytaradi; gateway `cancelled (sent)` ni
    // ro'yxatdagidek `cancelled` + transport_status ga aylantiradi.
    const rows = FE_UZ_STATUS_LABELS.map(([status], i) =>
      order(i + 1, { status }),
    );
    orderSend.mockImplementation((pattern: { cmd: string }) =>
      pattern.cmd === 'order.find_all_enriched'
        ? of({ data: rows, total: rows.length, page: 1, limit: 500 })
        : of({ data: {} }),
    );

    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/orders/export/excel')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const byId = statusById(await readSheet(res.body as Buffer));
    expect(byId.size).toBe(FE_UZ_STATUS_LABELS.length);
    FE_UZ_STATUS_LABELS.forEach(([, , label], i) => {
      expect(byId.get(String(i + 1))).toBe(label);
    });
    const cancelledSentId = String(
      FE_UZ_STATUS_LABELS.findIndex(
        ([s]) => s === Order_status.CANCELLED_SENT,
      ) + 1,
    );
    expect(byId.get(cancelledSentId)).toBe("Bekor — jo'natilgan");
  });
});
