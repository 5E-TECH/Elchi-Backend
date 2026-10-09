import { Logger } from '@nestjs/common';
import { NEVER, Subject, of, throwError } from 'rxjs';
import { Order_status } from '@app/common';
import {
  NOTIFY_LOOKUP_TIMEOUT_MS,
  OrderNotificationService,
  REGION_DIRECTORY_TTL_MS,
  buildOrderNotificationPayload,
  buildOrderTelegramText,
  buildRegionDirectory,
  formatTashkentDateTime,
} from './order-notification.service';

/**
 * OA16fdSq 5-band (nishon: market + operator + viloyat LOGISTI), 6-band
 * (Telegram matni BeePost mazmunida: mijoz, telefon, manzil, mahsulotlar,
 * narx, kuryer, operator, izoh — HTML-escape) va TC10/TC11 (in_app'da PII
 * yo'q; tranzaksiya ichidagi RPC qisqa, keshlangan, fail-open).
 */

const REGIONS = {
  statusCode: 200,
  message: 'success',
  data: [
    {
      id: '3',
      name: 'Toshkent sh.',
      logist_id: '77',
      districts: [
        { id: '31', name: 'Chilonzor' },
        { id: '32', name: 'Yunusobod' },
      ],
    },
    {
      id: '4',
      name: 'Andijon',
      logist_id: null,
      districts: [{ id: '41', name: 'Asaka' }],
    },
  ],
};

const baseOrder = (overrides: Record<string, unknown> = {}) =>
  ({
    id: '81',
    market_id: '5',
    operator_id: '9',
    operator: 'Operator Ali',
    customer_id: '2',
    courier_id: '55',
    holder_courier_id: '55',
    region_id: '3',
    district_id: '31',
    status: Order_status.SOLD,
    total_price: 150000,
    address: "Ko'cha 5-uy",
    comment: 'Eshik oldida',
    return_reason: null,
    createdAt: new Date('2026-10-09T09:05:00.000Z'),
    items: [],
    ...overrides,
  }) as any;

const cancelledOrder = (overrides: Record<string, unknown> = {}) =>
  baseOrder({
    status: Order_status.CANCELLED,
    return_reason: 'CUSTOMER_REFUSED',
    items: [
      { product_id: '700', product_name: null, quantity: 2 },
      { product_id: null, product_name: 'Hamkor kitobi', quantity: 1 },
      { product_id: '701', product_name: null, quantity: 1 },
    ],
    ...overrides,
  });

type Responder = (cmd: string, data: any) => any;

const client = (responder: Responder) => ({
  send: jest.fn((pattern: { cmd: string }, data: unknown) =>
    responder(pattern.cmd, data),
  ),
  emit: jest.fn(),
});

function makeService(
  options: {
    order?: any;
    logistics?: Responder;
    identity?: Responder;
    catalog?: Responder;
  } = {},
) {
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const orderRepo = {
    findOne: jest.fn().mockResolvedValue(options.order ?? baseOrder()),
  };
  const logisticsClient = client(options.logistics ?? (() => of(REGIONS)));
  const identityClient = client(
    options.identity ??
      ((cmd) =>
        of(
          cmd === 'identity.customer.find_by_ids'
            ? {
                success: true,
                data: [
                  {
                    id: '2',
                    name: 'Ali <VIP> & *Co*',
                    phone_number: '+998901112233',
                  },
                ],
              }
            : {
                success: true,
                data: [
                  { id: '55', name: 'Vali', phone_number: '+998907778899' },
                ],
              },
        )),
  );
  const catalogClient = client(
    options.catalog ?? (() => of({ data: [{ id: '700', name: 'Telefon' }] })),
  );
  const service = new OrderNotificationService(
    outbox as never,
    orderRepo as never,
    logisticsClient as never,
    identityClient as never,
    catalogClient as never,
  );
  const lastPayload = () =>
    outbox.enqueue.mock.calls[outbox.enqueue.mock.calls.length - 1]?.[2];
  return {
    service,
    outbox,
    orderRepo,
    logisticsClient,
    identityClient,
    catalogClient,
    lastPayload,
  };
}

const sold = {
  order_id: '81',
  from_status: Order_status.WAITING,
  to_status: Order_status.SOLD,
};
const cancelled = {
  order_id: '81',
  from_status: Order_status.WAITING,
  to_status: Order_status.CANCELLED,
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('buildRegionDirectory — logistics.region.find_all javobi', () => {
  it('successRes / xom massiv → region→logist, tuman→viloyat, nomlar', () => {
    for (const response of [REGIONS, REGIONS.data]) {
      const directory = buildRegionDirectory(response)!;
      expect(directory.logistByRegion).toEqual(new Map([['3', '77']]));
      expect(directory.regionByDistrict.get('41')).toBe('4');
      expect(directory.regionName.get('3')).toBe('Toshkent sh.');
      expect(directory.districtName.get('31')).toBe('Chilonzor');
    }
  });

  it('tanilmagan javob → null (eski kesh saqlanadi)', () => {
    expect(buildRegionDirectory(null)).toBeNull();
    expect(buildRegionDirectory({ statusCode: 500 })).toBeNull();
    expect(buildRegionDirectory('x')).toBeNull();
  });
});

describe('OA16fdSq 5-band: nishon — market + operator + viloyat logisti', () => {
  it('payload: logist qo‘shiladi, takror id bitta qoladi', () => {
    expect(
      buildOrderNotificationPayload('order.sold', baseOrder(), null, {
        logist_id: '77',
      })?.recipient_ids,
    ).toEqual(['5', '9', '77']);
    expect(
      buildOrderNotificationPayload('order.sold', baseOrder(), null, {
        logist_id: '5',
      })?.recipient_ids,
    ).toEqual(['5', '9']);
    expect(
      buildOrderNotificationPayload('order.sold', baseOrder(), null, {
        logist_id: '0',
      })?.recipient_ids,
    ).toEqual(['5', '9']);
  });

  it('onStatusChange: buyurtma viloyatining logisti (regions.logist_id) qabul qiluvchilarda', async () => {
    const { service, lastPayload, logisticsClient } = makeService();
    await service.onStatusChange(sold);
    expect(lastPayload().recipient_ids).toEqual(['5', '9', '77']);
    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.region.find_all' },
      {},
    );
  });

  it('region_id yo‘q — tumanning viloyati bo‘yicha topiladi', async () => {
    const { service, lastPayload } = makeService({
      order: baseOrder({ region_id: null, district_id: '32' }),
    });
    await service.onStatusChange(sold);
    expect(lastPayload().recipient_ids).toEqual(['5', '9', '77']);
  });

  it('viloyatda logist yo‘q — faqat market + operator', async () => {
    const { service, lastPayload } = makeService({
      order: baseOrder({ region_id: '4', district_id: '41' }),
    });
    await service.onStatusChange(sold);
    expect(lastPayload().recipient_ids).toEqual(['5', '9']);
  });
});

describe('TC11: region→logist KESHI — "Sotildi" RPC kutmaydi', () => {
  it('TTL ichida xarita qayta so‘ralmaydi (3 hodisa — 1 RPC)', async () => {
    const { service, logisticsClient, outbox } = makeService();
    await service.onStatusChange(sold);
    await service.onStatusChange({
      ...sold,
      from_status: Order_status.RECEIVED,
      to_status: Order_status.ON_THE_ROAD,
    });
    await service.onStatusChange(sold);
    expect(logisticsClient.send).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledTimes(3);
  });

  it('bir vaqtdagi hodisalar — BITTA so‘rov (single-flight)', async () => {
    const { service, logisticsClient, outbox } = makeService();
    await Promise.all([
      service.onStatusChange(sold),
      service.onStatusChange(sold),
      service.onStatusChange(sold),
    ]);
    expect(logisticsClient.send).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledTimes(3);
  });

  it('eskirgan kesh — DARHOL qaytariladi, yangilash fonda (hodisa uni kutmaydi)', async () => {
    const refresh = new Subject<unknown>();
    let calls = 0;
    const { service, lastPayload, logisticsClient } = makeService({
      logistics: () => (++calls === 1 ? of(REGIONS) : refresh),
    });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await service.onStatusChange(sold);

    clock.mockReturnValue(now + REGION_DIRECTORY_TTL_MS + 1);
    // yangilash javob bermay turibdi — hodisa baribir yakunlanadi (eski logist bilan)
    await service.onStatusChange(sold);
    expect(logisticsClient.send).toHaveBeenCalledTimes(2);
    expect(lastPayload().recipient_ids).toEqual(['5', '9', '77']);

    // yangilash keldi — keyingi hodisa YANGI logistni oladi
    refresh.next({
      data: [{ id: '3', name: 'Toshkent sh.', logist_id: '78', districts: [] }],
    });
    refresh.complete();
    await new Promise((resolve) => setImmediate(resolve));
    await service.onStatusChange(sold);
    expect(lastPayload().recipient_ids).toEqual(['5', '9', '78']);
  });

  it('logistics-service javob bermasa — timeout bilan chegaralangan, logistsiz davom etadi; keyingi hodisa umuman kutmaydi (backoff)', async () => {
    const { service, outbox, lastPayload, logisticsClient } = makeService({
      logistics: () => NEVER,
    });
    const started = Date.now();
    await service.onStatusChange(sold);
    const firstMs = Date.now() - started;
    expect(firstMs).toBeLessThan(NOTIFY_LOOKUP_TIMEOUT_MS + 400);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(lastPayload().recipient_ids).toEqual(['5', '9']);

    const secondStarted = Date.now();
    await service.onStatusChange(sold);
    expect(Date.now() - secondStarted).toBeLessThan(100);
    // backoff: ikkinchi hodisada RPC umuman yuborilmadi
    expect(logisticsClient.send).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
  });

  it('logistics xatosi — fail-open: bildirishnoma baribir outbox’da (logistsiz)', async () => {
    const { service, outbox, lastPayload } = makeService({
      logistics: () => throwError(() => new Error('ECONNREFUSED')),
    });
    await expect(service.onStatusChange(sold)).resolves.toBeUndefined();
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(lastPayload().recipient_ids).toEqual(['5', '9']);
  });

  it('sotuv (Telegram kanali yo‘q) — identity/catalog UMUMAN so‘ralmaydi, items JOIN qilinmaydi', async () => {
    const { service, identityClient, catalogClient, orderRepo } = makeService();
    await service.onStatusChange(sold);
    expect(identityClient.send).not.toHaveBeenCalled();
    expect(catalogClient.send).not.toHaveBeenCalled();
    expect(orderRepo.findOne).toHaveBeenCalledWith({ where: { id: '81' } });
  });
});

describe('OA16fdSq 6-band: Telegram matni BeePost mazmunida (faqat market guruhiga)', () => {
  it('bekor qilish: mijoz ismi/telefoni, manzil, mahsulotlar, narx, vaqt, kuryer, operator, sabab, izoh', async () => {
    const { service, lastPayload, identityClient, catalogClient, orderRepo } =
      makeService({ order: cancelledOrder() });
    await service.onStatusChange(cancelled);

    expect(orderRepo.findOne).toHaveBeenCalledWith({
      where: { id: '81' },
      relations: ['items'],
    });
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.customer.find_by_ids' },
      { ids: ['2'] },
    );
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.courier.find_by_ids' },
      { ids: ['55'] },
    );
    // faqat nomi saqlanmagan mahsulotlar so'raladi
    expect(catalogClient.send).toHaveBeenCalledWith(
      { cmd: 'catalog.product.find_by_ids' },
      { ids: ['700', '701'] },
    );

    const payload = lastPayload();
    expect(payload.recipient_ids).toEqual(['5', '9', '77']);
    expect(payload.channels).toContain('telegram');
    const text: string = payload.telegram.text;
    expect(text).toContain('❌ <b>Buyurtma bekor qilindi</b>');
    expect(text).toContain('Buyurtma: <b>#EL-100081</b>');
    expect(text).toContain('👤 <b>Mijoz:</b> Ali &lt;VIP&gt; &amp; *Co*');
    expect(text).toContain('📞 <b>Telefon:</b> +998901112233');
    expect(text).toContain(
      "📍 <b>Manzil:</b> Toshkent sh., Chilonzor, Ko'cha 5-uy",
    );
    expect(text).toContain('📦 <b>Mahsulotlar:</b>');
    expect(text).toContain('1. Telefon — 2 dona');
    expect(text).toContain('2. Hamkor kitobi — 1 dona');
    expect(text).toContain('3. Mahsulot #701 — 1 dona');
    expect(text).toContain("💰 <b>Narxi:</b> 150 000 so'm");
    expect(text).toContain('🕒 <b>Yaratilgan vaqti:</b> 09.10.2026 14:05');
    expect(text).toContain('🚚 <b>Kuryer:</b> Vali');
    expect(text).toContain('📞 <b>Kuryer bilan aloqa:</b> +998907778899');
    expect(text).toContain('👨‍💼 <b>Operator:</b> Operator Ali');
    expect(text).toContain('↩️ <b>Sabab:</b> Mijoz rad etdi');
    expect(text).toContain('📝 <b>Izoh:</b> Eshik oldida');
    // faqat bizning teglarimiz
    expect(new Set(text.match(/<\/?[a-z]+>/g))).toEqual(
      new Set(['<b>', '</b>']),
    );
  });

  it('TC10: in_app body/title/data’da mijoz ismi, telefoni va manzili YO‘Q (faqat telegram.text da)', async () => {
    const { service, lastPayload } = makeService({ order: cancelledOrder() });
    await service.onStatusChange(cancelled);
    const payload = lastPayload();
    expect(payload.body).toBe('Buyurtma #EL-100081 bekor qilindi.');
    const inApp = JSON.stringify({
      title: payload.title,
      body: payload.body,
      data: payload.data,
      link: payload.link,
      group_key: payload.group_key,
    });
    for (const pii of [
      '+998901112233',
      '+998907778899',
      'Ali',
      "Ko'cha",
      'Chilonzor',
      'Eshik',
    ]) {
      expect(inApp).not.toContain(pii);
    }
  });

  it('identity/catalog ishlamasa — fail-open: matn `-` bilan, bildirishnoma baribir ketadi', async () => {
    const { service, outbox, lastPayload } = makeService({
      order: cancelledOrder(),
      identity: () => throwError(() => new Error('identity down')),
      catalog: () => throwError(() => new Error('catalog down')),
    });
    await expect(service.onStatusChange(cancelled)).resolves.toBeUndefined();
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const text: string = lastPayload().telegram.text;
    expect(text).toContain('👤 <b>Mijoz:</b> -');
    expect(text).toContain('🚚 <b>Kuryer:</b> -');
    expect(text).toContain('1. Mahsulot #700 — 2 dona');
    expect(text).toContain('2. Hamkor kitobi — 1 dona');
  });

  it('mahsulot nomlari hammasi saqlangan bo‘lsa catalog so‘ralmaydi', async () => {
    const { service, catalogClient } = makeService({
      order: cancelledOrder({
        items: [{ product_id: '700', product_name: 'Telefon', quantity: 1 }],
      }),
    });
    await service.onStatusChange(cancelled);
    expect(catalogClient.send).not.toHaveBeenCalled();
  });

  it('juda uzun ro‘yxat/izoh — 4000 belgidan oshmaydi, teg/entity yarmida kesilmaydi', () => {
    const text = buildOrderTelegramText(
      'order.cancelled',
      cancelledOrder({ comment: '&<'.repeat(3000) }),
      {
        items: Array.from({ length: 60 }, (_, i) => ({
          name: `Mahsulot & <${i}> ${'x'.repeat(150)}`,
          quantity: 1,
        })),
      },
    );
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('… yana 40 ta');
    expect((text.match(/<b>/g) ?? []).length).toBe(
      (text.match(/<\/b>/g) ?? []).length,
    );
    expect(text.replace(/&(amp|lt|gt|quot);/g, '')).not.toContain('&');
  });

  it('Toshkent vaqti — UTC+5, ICU’ga bog‘liq emas', () => {
    expect(formatTashkentDateTime(new Date('2026-10-09T20:30:00Z'))).toBe(
      '10.10.2026 01:30',
    );
    expect(formatTashkentDateTime(null)).toBe('');
    expect(formatTashkentDateTime('yaroqsiz')).toBe('');
  });
});
