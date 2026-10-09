/// <reference types="jest" />
import { rmqSend } from '@app/common';
import { RmqContext, RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { OrderServiceController } from '../order-service.controller';
import { OrderServiceService } from '../order-service.service';
import {
  ORDER_SCAN_LIGHT_SELECT,
  toOrderScanLightView,
} from './order-scan-light.view';

/**
 * D148eHMA — skaner uchun YENGIL javob (`order.find_by_qr_light`).
 *
 * MUAMMO (2026-10-09 prod UI testi). Skaner ekranlari (scan detali, menejer
 * "Biriktirish", ro'yxatlardagi skan) `GET /orders/qr-code/:token` orqali
 * `order.find_by_qr_enriched` ning TO'LIQ daraxtini olardi: ~4.5 KB (barcha
 * pul snapshotlari, `branch` yozuvi, market tariflari/tokeni, mijozning
 * to'liq yozuvi, katalog mahsuloti). Kartaning 1-bandi — skaner ekraniga
 * kerakli maydonlar bilan cheklangan yengil javob — bajarilmagan edi.
 *
 * Bu spec: (1) yengil javob skaner ekrani o'qiydigan HAMMA maydonni beradi,
 * (2) og'ir/maxfiy maydonlar chiqmaydi, (3) to'liq javob O'ZGARMAGAN.
 */

jest.mock('@app/common', () => ({
  ...jest.requireActual<Record<string, unknown>>('@app/common'),
  rmqSend: jest.fn(),
}));

const rmqSendMock = rmqSend as unknown as jest.Mock;

type Row = Record<string, any>;

/** DB'dagi to'liq buyurtma (prod javobidagi shaklga yaqin). */
const DB_ORDER: Row = {
  id: '412',
  createdAt: '2026-10-09T08:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
  isDeleted: false,
  market_id: '16',
  customer_id: '901',
  product_quantity: 2,
  where_deliver: 'address',
  total_price: 185000,
  market_tariff: 25000,
  courier_tariff: 15000,
  courier_share: 15000,
  branch_share: 5000,
  branch_cashbox_amount: 160000,
  sale_collectible_amount: 185000,
  extra_cost: 0,
  paid_online_amount: 0,
  payment_status: null,
  to_be_paid: 160000,
  paid_amount: 0,
  status: 'received',
  comment: "Qo'ng'iroq qilib keling",
  operator: 'Ali operator',
  operator_id: '55',
  post_id: '71',
  canceled_post_id: null,
  return_requested: false,
  proof_files: null,
  sold_at: null,
  district_id: '7',
  region_id: '3',
  branch_id: '3',
  home_branch_id: '3',
  branch: {
    id: '3',
    name: 'Andijon filiali',
    address: 'Andijon sh., Navoiy 1',
    phone_number: '+998900000003',
    cashbox_balance: 12500000,
    manager_id: '25',
    createdAt: '2025-01-01T00:00:00.000Z',
  },
  current_batch_id: '88',
  courier_id: '37',
  assigned_at: null,
  holder_type: 'BRANCH',
  holder_branch_id: '3',
  holder_courier_id: null,
  last_handover_at: null,
  last_handover_by: null,
  return_reason: null,
  address: 'Navoiy ko`chasi 12',
  qr_code_token: 'c9f6d82e571cc6f19d6f2d26',
  parent_order_id: null,
  external_id: 'BP-77',
  external_batch_ref: null,
  external_batch_token: null,
  external_batch_size: null,
  source: 'external',
  deleted_at: null,
  items: [
    {
      id: '1001',
      createdAt: '2026-10-09T08:00:00.000Z',
      updatedAt: '2026-10-09T08:00:00.000Z',
      isDeleted: false,
      product_id: '501',
      product_name: null,
      order_id: '412',
      quantity: 2,
    },
  ],
};

/** Boshqa servislar javoblari (`enrichOrders` RMQ orqali oladi). */
const RMQ: Record<string, Row[]> = {
  'identity.market.find_by_ids': [
    {
      id: '16',
      name: 'TEST E2E Market',
      phone_number: '+998900000016',
      tariff_home: 25000,
      tariff_center: 20000,
      market_tg_token: 'tg-secret-token',
      default_tariff: 'address',
      settings: { notify: true },
    },
  ],
  'identity.customer.find_by_ids': [
    {
      id: '901',
      name: 'Aziz Karimov',
      phone_number: '+998901112233',
      extra_number: null,
      address: 'Navoiy ko`chasi 12',
      role: 'customer',
      status: 'active',
      created_by: '16',
    },
  ],
  'logistics.district.find_by_ids': [
    { id: '7', name: 'Andijon tumani', region_id: '3', sato_code: '1703' },
  ],
  'logistics.region.find_by_ids': [
    {
      id: '3',
      name: 'Andijon viloyati',
      assignedToRegion: { id: '3', name: 'Andijon viloyati' },
      districts: [{ id: '7', name: 'Andijon tumani' }],
    },
  ],
  'catalog.product.find_by_ids': [
    {
      id: '501',
      name: 'Kitob',
      price: 92500,
      image_url: 'https://cdn.example/kitob.png',
      market_id: '16',
    },
  ],
};

/** TypeORM `select` ni taqlid qiladi: faqat tanlangan ustunlar qaytadi. */
function applySelect(row: Row, select: Row): Row {
  const out: Row = {};
  for (const [key, flag] of Object.entries(select)) {
    if (flag === true) {
      out[key] = row[key];
    } else if (flag && typeof flag === 'object' && Array.isArray(row[key])) {
      out[key] = (row[key] as Row[]).map((item) => applySelect(item, flag));
    }
  }
  return out;
}

function buildSvc(dbOrder: Row | null = DB_ORDER) {
  const svc: any = Object.create(OrderServiceService.prototype);
  svc.identityClient = {};
  svc.logisticsClient = {};
  svc.catalogClient = {};
  svc.orderRepo = {
    findOne: jest.fn((opts: { select?: Row }) =>
      Promise.resolve(
        dbOrder && opts?.select
          ? applySelect(dbOrder, opts.select)
          : dbOrder
            ? structuredClone(dbOrder)
            : null,
      ),
    ),
  };
  return svc;
}

/** Skaner ekranlari (Elchi-Frontend) o'qiydigan maydonlar. */
function frontendScanFields(order: Row) {
  return {
    // pages/scan/detail.tsx + pages/dispatch (normalizeOrder)
    id: order.id,
    customerName: order.customer?.name,
    phone: order.customer?.phone_number,
    customerAddress: order.customer?.address,
    district: order.district?.name,
    region: order.region?.name,
    address: order.address,
    total: order.total_price,
    delivery: order.where_deliver,
    market: order.market?.name,
    operator: order.operator,
    comment: order.comment,
    createdAt: order.createdAt,
    status: order.status,
    products: (order.items ?? []).map((item: Row) => ({
      name: item.product?.name ?? item.product_name,
      quantity: item.quantity,
    })),
    // pages/orders, orders/list/courier, mails/detail — skan moslashtirish
    qr_code_token: order.qr_code_token,
    parent_order_id: order.parent_order_id,
    customer_id: order.customer_id,
    market_id: order.market_id,
    district_id: order.district_id,
    order_number: order.order_number,
  };
}

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

beforeEach(() => {
  rmqSendMock.mockReset();
  rmqSendMock.mockImplementation((_client, pattern: { cmd: string }) =>
    Promise.resolve({ data: structuredClone(RMQ[pattern.cmd] ?? []) }),
  );
});

describe('D148eHMA — OrderServiceService.findByQrCodeLight', () => {
  it('skaner ekrani o`qiydigan HAMMA maydon to`liq javobdagi bilan AYNI', async () => {
    const svc = buildSvc();

    const light: Row = (await svc.findByQrCodeLight(DB_ORDER.qr_code_token))
      .data;
    const full: Row = (await svc.findByQrCodeEnriched(DB_ORDER.qr_code_token))
      .data;

    expect(frontendScanFields(light)).toEqual(frontendScanFields(full));
    expect(frontendScanFields(light)).toMatchObject({
      id: '412',
      customerName: 'Aziz Karimov',
      phone: '+998901112233',
      district: 'Andijon tumani',
      region: 'Andijon viloyati',
      market: 'TEST E2E Market',
      products: [{ name: 'Kitob', quantity: 2 }],
      order_number: 'EL-100412',
      market_id: '16',
    });
  });

  it('og`ir/maxfiy maydonlar (pul snapshotlari, branch, market tokeni) CHIQMAYDI', async () => {
    const svc = buildSvc();

    const light: Row = (await svc.findByQrCodeLight(DB_ORDER.qr_code_token))
      .data;

    for (const key of [
      'market_tariff',
      'courier_tariff',
      'courier_share',
      'branch_share',
      'branch_cashbox_amount',
      'sale_collectible_amount',
      'to_be_paid',
      'paid_amount',
      'branch',
      'branch_id',
      'courier_id',
      'holder_type',
      'external_id',
      'post_id',
    ]) {
      expect(light).not.toHaveProperty(key);
    }
    expect(light.market).toEqual({ id: '16', name: 'TEST E2E Market' });
    expect(light.customer).toEqual({
      id: '901',
      name: 'Aziz Karimov',
      phone_number: '+998901112233',
      address: 'Navoiy ko`chasi 12',
    });
    expect(light.region).toEqual({ id: '3', name: 'Andijon viloyati' });
    expect(light.items).toEqual([
      {
        id: '1001',
        product_id: '501',
        product_name: null,
        quantity: 2,
        product: { id: '501', name: 'Kitob' },
      },
    ]);
    expect(JSON.stringify(light)).not.toContain('tg-secret-token');
    expect(JSON.stringify(light)).not.toContain('cashbox');
  });

  it('javob hajmi to`liq javobning yarmidan ham kichik', async () => {
    const svc = buildSvc();

    const light = await svc.findByQrCodeLight(DB_ORDER.qr_code_token);
    const full = await svc.findByQrCodeEnriched(DB_ORDER.qr_code_token);

    expect(bytes(light) * 2).toBeLessThan(bytes(full));
  });

  it('DB: faqat kerakli ustunlar o`qiladi, `branch` JOIN qilinmaydi; qidiruv sharti to`liq javob bilan AYNI', async () => {
    const svc = buildSvc();

    await svc.findByQrCodeLight('tok-1');

    const opts = svc.orderRepo.findOne.mock.calls[0][0];
    expect(opts.where).toEqual({ qr_code_token: 'tok-1', isDeleted: false });
    expect(opts.relations).toEqual({ items: true });
    expect(opts.select).toBe(ORDER_SCAN_LIGHT_SELECT);
    expect(opts.select).not.toHaveProperty('branch');
    expect(opts.select).not.toHaveProperty('market_tariff');
    // Gateway'dagi market ko'rinish tekshiruvi (`assertQrOrderVisible`) shu
    // maydonga tayanadi — u tushib qolsa market o'z posilkasini ham ko'rmaydi.
    expect(opts.select).toHaveProperty('market_id', true);
  });

  it('topilmasa 404 (RpcException statusCode=404)', async () => {
    const svc = buildSvc(null);

    const error = await svc.findByQrCodeLight('YOQ').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 404,
    });
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('bo`sh/yo`q token -> 404 va DB so`rovi UMUMAN qilinmaydi (TypeORM `undefined` shartni tashlab ixtiyoriy buyurtma qaytarmasin)', async () => {
    const svc = buildSvc();

    for (const token of ['', '   ', undefined, null]) {
      await expect(svc.findByQrCodeLight(token)).rejects.toBeInstanceOf(
        RpcException,
      );
    }
    expect(svc.orderRepo.findOne).not.toHaveBeenCalled();
  });

  it('to`liq javob (`findByQrCodeEnriched`) O`ZGARMAGAN: pul, branch, to`liq market saqlanadi', async () => {
    const svc = buildSvc();

    const full: Row = (await svc.findByQrCodeEnriched('tok-1')).data;

    expect(svc.orderRepo.findOne.mock.calls[0][0]).toEqual({
      where: { qr_code_token: 'tok-1', isDeleted: false },
      relations: { items: true, branch: true },
    });
    expect(full).toMatchObject({
      market_tariff: 25000,
      branch_cashbox_amount: 160000,
      branch: { id: '3', name: 'Andijon filiali' },
      market: { market_tg_token: 'tg-secret-token' },
    });
  });
});

describe('D148eHMA — toOrderScanLightView', () => {
  it('kirish obyektini o`zgartirmaydi', () => {
    const input = structuredClone(DB_ORDER);
    const snapshot = structuredClone(input);

    toOrderScanLightView(input);

    expect(input).toEqual(snapshot);
  });

  it('nomlar topilmasa (enrich xatosi) — `null`, qator yiqilmaydi', () => {
    const view = toOrderScanLightView({
      id: '5',
      market: null,
      customer: {},
      district: undefined,
      items: [{ id: '1', quantity: 1, product: null }, null],
    });

    expect(view).toEqual({
      id: '5',
      market: null,
      customer: null,
      district: null,
      region: null,
      items: [{ id: '1', quantity: 1, product: null }, { product: null }],
    });
  });

  it('obyekt bo`lmagan kirish — bo`sh ko`rinish (throw emas)', () => {
    expect(toOrderScanLightView(null)).toEqual({
      market: null,
      customer: null,
      district: null,
      region: null,
      items: [],
    });
  });
});

describe('D148eHMA — order.find_by_qr_light naqshi', () => {
  const patternOf = (method: string) =>
    Reflect.getMetadata(
      PATTERN_METADATA,
      Object.getOwnPropertyDescriptor(OrderServiceController.prototype, method)
        ?.value as object,
    ) as unknown;

  it("naqsh AYNAN { cmd: 'order.find_by_qr_light' }; eski naqshlar o`z joyida", () => {
    expect(patternOf('findByQrLight')).toEqual([
      { cmd: 'order.find_by_qr_light' },
    ]);
    expect(patternOf('findByQr')).toEqual([{ cmd: 'order.find_by_qr' }]);
    expect(patternOf('findByQrEnriched')).toEqual([
      { cmd: 'order.find_by_qr_enriched' },
    ]);
  });

  it('token findByQrCodeLight ga boradi', async () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderServiceController.prototype,
      'findByQrLight',
    )?.value as (data: unknown, context: RmqContext) => Promise<unknown>;
    const orderService = {
      findByQrCodeLight: jest.fn().mockResolvedValue({ data: { id: '1' } }),
    };
    const executeAndAck = jest.fn(
      (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
    );

    await expect(
      handler.call(
        { executeAndAck, orderService },
        { token: 'tok-1' },
        {} as RmqContext,
      ),
    ).resolves.toEqual({ data: { id: '1' } });
    expect(orderService.findByQrCodeLight).toHaveBeenCalledWith('tok-1');
  });
});
