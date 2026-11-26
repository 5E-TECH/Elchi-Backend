import { Logger } from '@nestjs/common';
import { NEVER, Subject, of, throwError } from 'rxjs';
import { Order_status } from '@app/common';
import { validateTelegramHtml } from '@app/common/notification/telegram-html-kit-spec';
import {
  MARKET_CONTACTS_TTL_MS,
  NOTIFY_LOOKUP_TIMEOUT_MS,
  ORDER_PILOT_NOTIFICATION_TYPES,
  OrderNotificationService,
  REGION_DIRECTORY_TTL_MS,
  buildOrderNotificationPayload,
  buildOrderTelegramText,
  buildRegionDirectory,
  formatTashkentDateTime,
  marketContactsFromResponse,
  withoutPhones,
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

/**
 * Ko'chirilgan tuman: Chust (42) geografik jihatdan Andijon (4) da, lekin
 * `assigned_region` — Toshkent sh. (3). `districts` — geografik ro'yxat.
 */
const REGIONS_MOVED = {
  ...REGIONS,
  data: [
    REGIONS.data[0],
    {
      ...REGIONS.data[1],
      districts: [
        { id: '41', name: 'Asaka', assigned_region: null },
        { id: '42', name: 'Chust', assigned_region: '3' },
      ],
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

/**
 * (txZJQiCe) `identity.contacts.for_user` javobi (`GET /users/me/contacts`
 * bilan AYNI) — market mas'uli logist.
 */
const contactsReply = (
  contacts: Array<{ name: string | null; phone: string }>,
  source: string | null = 'assigned',
  kind = 'market_responsible',
) => ({
  statusCode: 200,
  message: 'success',
  data: {
    kind,
    source: contacts.length ? source : null,
    regions: [],
    contacts: contacts.map((contact, index) => ({
      user_id: contact.name ? String(900 + index) : null,
      name: contact.name,
      phone: contact.phone,
      role: contact.name ? 'logist' : null,
    })),
  },
});
const LOGIST_CONTACTS = contactsReply([
  { name: 'Laylo Logist', phone: '+998901234567' },
]);
const LOGIST_LINE =
  "📞 <b>Elchi mas'ulingiz:</b> Laylo Logist — +998 90 123 45 67";
/** Kuryer (55) telefoni — matnda HECH QANDAY ko'rinishda bo'lmasligi kerak. */
const COURIER_PHONE_FORMS = ['+998907778899', '907778899', '90 777 88 99'];

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
          cmd === 'identity.contacts.for_user'
            ? LOGIST_CONTACTS
            : cmd === 'identity.customer.find_by_ids'
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

describe('LC-13: tuman → XIZMAT viloyati (assigned_region ?? region_id)', () => {
  it('ko‘chirilgan tuman biriktirilgan viloyatga, nomi o‘zgarmaydi', () => {
    const directory = buildRegionDirectory(REGIONS_MOVED)!;
    expect(directory.regionByDistrict.get('42')).toBe('3');
    expect(directory.districtName.get('42')).toBe('Chust');
  });

  it('assigned_region NULL / yo‘q — tumanning o‘z viloyati', () => {
    const directory = buildRegionDirectory(REGIONS_MOVED)!;
    expect(directory.regionByDistrict.get('41')).toBe('4');
    expect(directory.regionByDistrict.get('31')).toBe('3');
  });

  it('viloyatlar tartibiga bog‘liq emas', () => {
    const reversed = buildRegionDirectory([...REGIONS_MOVED.data].reverse())!;
    expect(reversed.regionByDistrict).toEqual(
      buildRegionDirectory(REGIONS_MOVED)!.regionByDistrict,
    );
    expect(reversed.regionByDistrict.get('42')).toBe('3');
  });

  it('region_id yo‘q buyurtma — ko‘chirilgan tuman viloyati (3) logistiga', async () => {
    const { service, lastPayload } = makeService({
      order: baseOrder({ region_id: null, district_id: '42' }),
      logistics: () => of(REGIONS_MOVED),
    });
    await service.onStatusChange(sold);
    expect(lastPayload().recipient_ids).toEqual(['5', '9', '77']);
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
    // (txZJQiCe) kuryer telefoni o'rniga market mas'uli (logist)
    expect(text).toContain(LOGIST_LINE);
    expect(text).not.toContain('Kuryer bilan aloqa');
    for (const phone of COURIER_PHONE_FORMS) {
      expect(text).not.toContain(phone);
    }
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.contacts.for_user' },
      { user_id: '5' },
    );
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
    // (BOT-2 #1) market sozlamasi o'qilmadi — FAIL-CLOSED: ism qatori yo'q.
    expect(text).not.toContain('👤 <b>Mijoz:</b>');
    expect(text).toContain('📞 <b>Telefon:</b> -');
    expect(text).toContain('🚚 <b>Kuryer:</b> -');
    // (txZJQiCe) identity yo'q — mas'ul qatori ham, kuryer raqami ham yo'q
    expect(text).not.toContain("Elchi mas'ulingiz");
    expect(text).not.toContain('Kuryer bilan aloqa');
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

describe("txZJQiCe: market guruhida «Kuryer bilan aloqa» o'rniga Elchi mas'uli", () => {
  const CONTACT_PREFIX = "📞 <b>Elchi mas'ulingiz:</b>";
  const contactLines = (text: string) =>
    text.split('\n').filter((line) => line.startsWith(CONTACT_PREFIX));
  const expectNoCourierPhone = (text: string) => {
    expect(text).not.toContain('Kuryer bilan aloqa');
    for (const phone of COURIER_PHONE_FORMS) {
      expect(text).not.toContain(phone);
    }
  };
  /** Telegram ketadigan sotuv: narx tushirib sotildi (`order.sold_cheaper`). */
  const soldCheaperOrder = (overrides: Record<string, unknown> = {}) =>
    baseOrder({
      total_price: 120000,
      partly_sell_original_total_price: 150000,
      ...overrides,
    });
  /** identity: mas'ul javobi `contacts` dan, qolganlari odatdagidek. */
  const identityWith =
    (
      contacts: (data: any) => any,
      options: { pii?: boolean } = {},
    ): Responder =>
    (cmd, data) => {
      if (cmd === 'identity.contacts.for_user') return contacts(data);
      if (cmd === 'identity.customer.find_by_ids') {
        return of({
          data: [
            { id: '2', name: 'Ali Valiyev', phone_number: '+998901112233' },
          ],
        });
      }
      if (cmd === 'identity.user.find_by_id') {
        return of({
          data: { id: data.id, tg_group_show_customer_pii: options.pii },
        });
      }
      return of({
        data: [{ id: '55', name: 'Vali', phone_number: '+998907778899' }],
      });
    };
  const telegramText = (payload: any): string => payload.telegram.text;

  it('TC1: mas`uli logist market — «Sotildi» (arzonroq) xabarida «Elchi mas`ulingiz: <logist> — +998 …», «Kuryer bilan aloqa» yo`q', async () => {
    const { service, lastPayload, identityClient } = makeService({
      order: soldCheaperOrder(),
    });
    await service.onStatusChange(sold);

    const payload = lastPayload();
    expect(payload.type).toBe('order.sold_cheaper');
    expect(payload.channels).toContain('telegram');
    const text = telegramText(payload);
    expect(contactLines(text)).toEqual([LOGIST_LINE]);
    expectNoCourierPhone(text);
    // rezolver — `GET /users/me/contacts` bilan AYNI pattern, market user_id bilan
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.contacts.for_user' },
      { user_id: '5' },
    );
    // in_app (logistga ham boradi) — telefonlar yo'q
    expect(payload.body).not.toContain('+998');
  });

  it('TC2: «Bekor qilindi», «Arzonroq sotildi», «Qisman sotildi» va boshqa barcha turlar — bir xil qoida', async () => {
    // xizmat orqali: Telegram ketadigan ikkala tur
    for (const [order, transition] of [
      [cancelledOrder(), cancelled],
      [soldCheaperOrder(), sold],
    ] as const) {
      const { service, lastPayload } = makeService({ order });
      await service.onStatusChange(transition);
      const text = telegramText(lastPayload());
      expect(contactLines(text)).toEqual([LOGIST_LINE]);
      expectNoCourierPhone(text);
    }
    // matn quruvchi: HAR tur (qisman sotilgan buyurtma ham) — kuryer
    // telefoni berilsa ham chiqmaydi, HTML yaroqli
    for (const type of ORDER_PILOT_NOTIFICATION_TYPES) {
      const text = buildOrderTelegramText(
        type,
        soldCheaperOrder({ status: Order_status.PARTLY_PAID }),
        {
          courier: { name: 'Vali', phone_number: '+998907778899' } as never,
          responsible_contacts: [
            { name: 'Laylo Logist', phone: '+998901234567' },
          ],
        },
      );
      expect(contactLines(text)).toEqual([LOGIST_LINE]);
      expectNoCourierPhone(text);
      expect(validateTelegramHtml(text)).toEqual(
        expect.objectContaining({ ok: true }),
      );
    }
  });

  it('TC3: mas`ulsiz market → sukut mas`ul; sukut ham yo`q → zaxira raqamlar, har biri alohida qatorda', async () => {
    const byDefault = makeService({
      order: cancelledOrder(),
      identity: identityWith(() =>
        of(
          contactsReply(
            [{ name: 'Sukut Registrator', phone: '+998935556677' }],
            'default',
          ),
        ),
      ),
    });
    await byDefault.service.onStatusChange(cancelled);
    expect(contactLines(telegramText(byDefault.lastPayload()))).toEqual([
      `${CONTACT_PREFIX} Sukut Registrator — +998 93 555 66 77`,
    ]);

    const support = makeService({
      order: cancelledOrder(),
      identity: identityWith(() =>
        of(
          contactsReply(
            [
              { name: null, phone: '+998712001122' },
              { name: null, phone: '+998712003344' },
            ],
            'support',
          ),
        ),
      ),
    });
    await support.service.onStatusChange(cancelled);
    const text = telegramText(support.lastPayload());
    expect(contactLines(text)).toEqual([
      `${CONTACT_PREFIX} +998 71 200 11 22`,
      `${CONTACT_PREFIX} +998 71 200 33 44`,
    ]);
    expectNoCourierPhone(text);
    // ikkala holatda ham so'rov — market user_id bilan (tartibni identity hal qiladi)
    for (const { identityClient } of [byDefault, support]) {
      expect(identityClient.send).toHaveBeenCalledWith(
        { cmd: 'identity.contacts.for_user' },
        { user_id: '5' },
      );
    }
  });

  it('TC4: hech qanday raqam yo`q → mas`ul qatori chiqmaydi; kuryer telefoni hech qanday holatda chiqmaydi', async () => {
    const empty = makeService({
      order: cancelledOrder(),
      identity: identityWith(() => of(contactsReply([], null))),
    });
    await empty.service.onStatusChange(cancelled);
    const text = telegramText(empty.lastPayload());
    expect(contactLines(text)).toEqual([]);
    expectNoCourierPhone(text);
    // «Kuryer» qatoridan keyin darhol «Operator» (bo'sh qator ham yo'q)
    expect(text).toContain(
      '🚚 <b>Kuryer:</b> Vali\n👨‍💼 <b>Operator:</b> Operator Ali',
    );

    // zaxira raqam sifatida kuryer raqami kiritilgan bo'lsa ham — tashlanadi
    const courierAsSupport = makeService({
      order: cancelledOrder(),
      identity: identityWith(() =>
        of(
          contactsReply(
            [
              { name: null, phone: '+998 90 777 88 99' },
              { name: null, phone: '+998712001122' },
            ],
            'support',
          ),
        ),
      ),
    });
    await courierAsSupport.service.onStatusChange(cancelled);
    const text2 = telegramText(courierAsSupport.lastPayload());
    expect(contactLines(text2)).toEqual([
      `${CONTACT_PREFIX} +998 71 200 11 22`,
    ]);
    expectNoCourierPhone(text2);

    // market bo'lmagan / tanilmagan javob — qator yo'q
    for (const reply of [
      contactsReply(
        [{ name: 'Viloyat logisti', phone: '+998901234567' }],
        'assigned',
        'region_logist',
      ),
      contactsReply([], null, 'none'),
      { data: [{ id: '55', name: 'Vali', phone_number: '+998907778899' }] },
      null,
      'x',
    ]) {
      expect(marketContactsFromResponse(reply)).toEqual([]);
    }
  });

  it('TC5: mas`ul almashtirilgandan keyin (PATCH /markets/:id/responsible) keyingi xabarda yangi raqam — kesh ≤ 60 s', async () => {
    expect(MARKET_CONTACTS_TTL_MS).toBeLessThanOrEqual(60_000);
    let current = [{ name: 'Eski Logist', phone: '+998901000001' }];
    const { service, lastPayload, identityClient } = makeService({
      order: cancelledOrder(),
      identity: identityWith(() => of(contactsReply(current))),
    });
    const contactCalls = () =>
      identityClient.send.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as { cmd: string }).cmd === 'identity.contacts.for_user',
      ).length;
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    await service.onStatusChange(cancelled);
    expect(contactLines(telegramText(lastPayload()))).toEqual([
      `${CONTACT_PREFIX} Eski Logist — +998 90 100 00 01`,
    ]);

    // mas'ul almashtirildi
    current = [{ name: 'Yangi Logist', phone: '+998901000002' }];
    clock.mockReturnValue(now + MARKET_CONTACTS_TTL_MS - 1);
    await service.onStatusChange(cancelled);
    expect(contactCalls()).toBe(1); // kesh ichida — RPC yo'q

    clock.mockReturnValue(now + MARKET_CONTACTS_TTL_MS + 1);
    await service.onStatusChange(cancelled);
    expect(contactCalls()).toBe(2);
    expect(contactLines(telegramText(lastPayload()))).toEqual([
      `${CONTACT_PREFIX} Yangi Logist — +998 90 100 00 02`,
    ]);

    // boshqa market — o'z keshi (birinchi marketniki unga o'tmaydi)
    (service as any).orderRepo.findOne.mockResolvedValue(
      cancelledOrder({ market_id: '6' }),
    );
    await service.onStatusChange(cancelled);
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.contacts.for_user' },
      { user_id: '6' },
    );
  });

  it('TC6: identity javob bermasa (timeout ≤ 3 s) — xabar baribir ketadi, mas`ul qatorisiz va kuryer raqamisiz', async () => {
    expect(NOTIFY_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    const { service, outbox, lastPayload } = makeService({
      order: cancelledOrder(),
      identity: identityWith(() => NEVER),
    });
    const started = Date.now();
    await expect(service.onStatusChange(cancelled)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const text = telegramText(lastPayload());
    expect(contactLines(text)).toEqual([]);
    expectNoCourierPhone(text);
    expect(text).toContain('🚚 <b>Kuryer:</b> Vali');

    // biznes xatosi (market topilmadi — 404) — qatorsiz, lekin backoff YO'Q:
    // keyingi xabar yana so'raydi va mas'ulni oladi
    let calls = 0;
    const flaky = makeService({
      order: cancelledOrder(),
      identity: identityWith(() =>
        ++calls === 1
          ? throwError(() => ({ statusCode: 404, message: 'User topilmadi' }))
          : of(LOGIST_CONTACTS),
      ),
    });
    await flaky.service.onStatusChange(cancelled);
    expect(contactLines(telegramText(flaky.lastPayload()))).toEqual([]);
    await flaky.service.onStatusChange(cancelled);
    expect(contactLines(telegramText(flaky.lastPayload()))).toEqual([
      LOGIST_LINE,
    ]);
  });

  it('TC7: «🚚 Kuryer: <ism>» qoladi; show_customer_pii o`chiq marketda mijoz PII qoidasi o`zgarmaydi', async () => {
    const hidden = makeService({
      order: cancelledOrder(),
      identity: identityWith(() => of(LOGIST_CONTACTS), { pii: false }),
    });
    await hidden.service.onStatusChange(cancelled);
    const text = telegramText(hidden.lastPayload());
    expect(text).toContain('🚚 <b>Kuryer:</b> Vali');
    expect(contactLines(text)).toEqual([LOGIST_LINE]);
    expect(text).not.toContain('👤 <b>Mijoz:</b>');
    expect(text).not.toContain('Ali Valiyev');
    expect(text).toContain('📞 <b>Telefon:</b> +998 90 *** ** 33');
    expect(text).toContain('📍 <b>Manzil:</b> Chilonzor');
    expect(text).not.toContain("Ko'cha 5-uy");
    expect(text).not.toContain('📝 <b>Izoh:</b>');
    expectNoCourierPhone(text);

    const shown = makeService({
      order: cancelledOrder(),
      identity: identityWith(() => of(LOGIST_CONTACTS), { pii: true }),
    });
    await shown.service.onStatusChange(cancelled);
    const full = telegramText(shown.lastPayload());
    expect(full).toContain('👤 <b>Mijoz:</b> Ali Valiyev');
    expect(full).toContain('📞 <b>Telefon:</b> +998901112233');
    expect(full).toContain('🚚 <b>Kuryer:</b> Vali');
    expect(contactLines(full)).toEqual([LOGIST_LINE]);
  });

  it('ism/telefon HTML-escape qilinadi, takror raqam bitta, telefonsiz element tashlanadi, ≤ 3 qator', () => {
    const contacts = marketContactsFromResponse(
      contactsReply([
        { name: 'Ali <b>&</b>', phone: '+998901234567' },
        { name: 'Takror', phone: '+998 90 123 45 67' },
        { name: 'Telefonsiz', phone: '' },
        { name: null, phone: '+998712001122' },
        { name: null, phone: '+998712003344' },
        { name: null, phone: '+998712005566' },
      ]),
    );
    expect(contacts).toEqual([
      { name: 'Ali <b>&</b>', phone: '+998901234567' },
      { name: null, phone: '+998712001122' },
      { name: null, phone: '+998712003344' },
    ]);
    expect(withoutPhones(contacts, ['998712001122', null])).toEqual([
      contacts[0],
      contacts[2],
    ]);
    const text = buildOrderTelegramText('order.cancelled', cancelledOrder(), {
      responsible_contacts: contacts,
    });
    expect(contactLines(text)[0]).toBe(
      `${CONTACT_PREFIX} Ali &lt;b&gt;&amp;&lt;/b&gt; — +998 90 123 45 67`,
    );
    expect(validateTelegramHtml(text)).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });
});
