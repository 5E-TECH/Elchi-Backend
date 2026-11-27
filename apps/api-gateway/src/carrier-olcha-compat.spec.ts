import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { TimeoutError } from 'rxjs';
import { CARRIER_ERROR_CODES } from '@app/common';
import { readExternalItemsText } from '../../order-service/src/lifecycle/external-items-text';
import {
  CarrierOlchaExceptionFilter,
  formatSom,
  olchaPhone,
  tashkentDateTime,
  toCarrierQrOrderData,
} from './carrier-olcha-compat';

/**
 * Olcha `QrOrderResponse.data` (https://api.olchamarket.uz/swagger.json,
 * 2026-11-27) maydonlari — ro'yxat aynan shu tartibda va shu nomlarda.
 */
const OLCHA_QR_ORDER_FIELDS = [
  'id',
  'full_name',
  'phone',
  'additional_phone',
  'region',
  'district',
  'address',
  'comment',
  'delivery_price',
  'total_price',
  'total_count',
  'created_at',
  'items',
];

const order = (overrides: Record<string, unknown> = {}) => ({
  id: '900',
  order_number: 'E-900',
  qr_code_token: 'qr-900',
  status: 'waiting',
  courier_id: '55',
  total_price: 250000,
  paid_online_amount: 0,
  address: 'Chilonzor 10-kvartal, 5-uy',
  comment: "Qo'ng'iroq qiling",
  region_id: '1',
  district_id: '7',
  customer: {
    name: 'Alisher Navoiy',
    phone_number: '+998901234567',
    extra_number: '+998909876543',
  },
  region: { id: '1', sato_code: '1726' },
  district: { id: '7', sato_code: '1726294' },
  market: { id: '20', name: 'Shop' },
  items: [{ id: '1', product_id: '1', product_name: 'Kurtka', quantity: 2 }],
  createdAt: '2025-01-20T09:30:00.000Z',
  ...overrides,
});

describe('toCarrierQrOrderData — Olcha QrOrderResponse.data', () => {
  it('⭐ Olcha’ning barcha maydonlari, shu nomlar va turlar bilan', () => {
    const data = toCarrierQrOrderData(order());
    expect(Object.keys(data).slice(0, OLCHA_QR_ORDER_FIELDS.length)).toEqual(
      OLCHA_QR_ORDER_FIELDS,
    );
    expect(data).toEqual({
      id: 900,
      full_name: 'Alisher Navoiy',
      phone: '998901234567',
      additional_phone: '998909876543',
      region: 1726,
      district: 1726294,
      address: 'Chilonzor 10-kvartal, 5-uy',
      comment: "Qo'ng'iroq qiling",
      delivery_price: 0,
      total_price: 250000,
      total_count: 2,
      created_at: '2025-01-20 14:30:00',
      items: "Kurtka x 2 = 250 000 so'm",
      // Elchi qo'shimchalari (Olcha'da yo'q) — oxirida.
      status: 'waiting',
      paid_online_amount: 0,
    });
  });

  it('⭐ total_price = mijozdan olinadigan naqd (onlayn to‘langan qism ayirilgan), delivery_price 0', () => {
    const data = toCarrierQrOrderData(
      order({ total_price: 200000, paid_online_amount: 50000 }),
    );
    expect(data.total_price).toBe(150000);
    expect(data.delivery_price).toBe(0);
    expect(data.paid_online_amount).toBe(50000);
    // Olcha mijozi naqdni total_price + delivery_price deb oladi.
    expect(data.total_price + data.delivery_price).toBe(150000);
  });

  it('bir nechta mahsulot: narx o‘ylab topilmaydi — `A x 1, B x 2`, total_count yig‘indi', () => {
    const data = toCarrierQrOrderData(
      order({
        items: [
          { id: '1', product_name: 'Soat', quantity: 1 },
          { id: '2', product_name: 'Kamar', quantity: 2 },
        ],
      }),
    );
    expect(data.items).toBe('Soat x 1, Kamar x 2');
    expect(data.total_count).toBe(3);
  });

  it('⭐ items matni Elchi’ning o‘z sayt-import qoidasi bilan qayta o‘qiladi (round-trip)', () => {
    const one = toCarrierQrOrderData(order());
    expect(readExternalItemsText(one.items, one.total_count)).toEqual([
      { product_name: 'Kurtka', quantity: 2 },
    ]);
  });

  it('yo‘q qiymatlar: satrlar bo‘sh satr (Olcha sxemasida nullable emas), SOATO noma’lum — null', () => {
    const data = toCarrierQrOrderData(
      order({
        comment: null,
        address: null,
        customer: { name: null, phone_number: null },
        region: { id: '1', sato_code: 'REG-01' },
        district: { id: '7', sato_code: null },
        items: [],
        createdAt: null,
      }),
    );
    expect(data).toMatchObject({
      full_name: '',
      phone: '',
      additional_phone: '',
      address: '',
      comment: '',
      region: null,
      district: null,
      items: '',
      total_count: 0,
      created_at: '',
    });
  });

  it('ichki maydonlar sizmaydi (allowlist)', () => {
    const data = toCarrierQrOrderData(
      order({ courier_tariff: 25000, branch: { id: '4' }, market_tariff: 1 }),
    ) as Record<string, unknown>;
    for (const key of ['courier_tariff', 'branch', 'market_tariff', 'market']) {
      expect(data).not.toHaveProperty(key);
    }
  });
});

describe('Olcha formatlari', () => {
  it('telefon: faqat raqam, 998 bilan', () => {
    expect(olchaPhone('+998 90 123-45-67')).toBe('998901234567');
    expect(olchaPhone('901234567')).toBe('998901234567');
    expect(olchaPhone(null)).toBe('');
  });

  it('summa: minglik bo‘shliq, butun so‘m', () => {
    expect(formatSom(250000)).toBe('250 000');
    expect(formatSom(1234567.6)).toBe('1 234 568');
    expect(formatSom(500)).toBe('500');
  });

  it('sana: Toshkent vaqti `YYYY-MM-DD HH:mm:ss`', () => {
    expect(tashkentDateTime('2026-11-27T20:15:09.000Z')).toBe(
      '2026-11-28 01:15:09',
    );
    expect(tashkentDateTime(new Date('2026-01-01T00:00:00Z'))).toBe(
      '2026-01-01 05:00:00',
    );
    expect(tashkentDateTime('not a date')).toBe('');
  });
});

describe('CarrierOlchaExceptionFilter', () => {
  const run = (mode: 'auth' | 'result', exception: unknown) => {
    const headers: Record<string, string> = {};
    const out: { status: number; body: unknown } = {
      status: 0,
      body: undefined,
    };
    const res = {
      status(code: number) {
        out.status = code;
        return res;
      },
      json(body: unknown) {
        out.body = body;
        return res;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      getHeader(name: string) {
        return headers[name];
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({}),
        getNext: () => undefined,
      }),
    } as unknown as ArgumentsHost;
    new CarrierOlchaExceptionFilter(mode).catch(exception, host);
    return { status: out.status, body: out.body, headers };
  };

  it('⭐ 401 — Olcha (Yii2) shakli, HTTP 401', () => {
    expect(
      run('result', new UnauthorizedException('Token yaroqsiz')),
    ).toMatchObject({
      status: 401,
      body: {
        name: 'Unauthorized',
        message: 'Token yaroqsiz',
        code: 0,
        status: 401,
      },
    });
  });

  it('⭐ auth rejimi: 400 ham Yii2 shaklida, HTTP 400', () => {
    expect(
      run('auth', new BadRequestException('username va password majburiy')),
    ).toEqual({
      status: 400,
      body: {
        name: 'Bad Request',
        message: 'username va password majburiy',
        code: 0,
        status: 400,
      },
      headers: {},
    });
  });

  it('⭐ result rejimi: 404/400 — `{success:false,msg,status}` HTTP 200 da (Olcha kabi)', () => {
    expect(run('result', new NotFoundException('Topilmadi'))).toMatchObject({
      status: 200,
      body: { success: false, msg: 'Topilmadi', status: 404 },
    });
    expect(
      run('result', new BadRequestException('qr_code majburiy')),
    ).toMatchObject({
      status: 200,
      body: { success: false, msg: 'qr_code majburiy', status: 400 },
    });
  });

  it('5xx — o‘z HTTP holati, mashina kodi `error_code` da, Retry-After saqlanadi', () => {
    const out = run(
      'result',
      new ServiceUnavailableException({
        statusCode: 503,
        message: 'Vaqtinchalik',
        code: CARRIER_ERROR_CODES.TEMPORARILY_UNAVAILABLE,
      }),
    );
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({
      success: false,
      msg: 'Vaqtinchalik',
      status: 503,
      error_code: 'CARRIER_TEMPORARILY_UNAVAILABLE',
    });
    expect(out.headers['Retry-After']).toBeDefined();
  });

  it('403 mashina kodi bilan — Yii2 shakli + error_code', () => {
    const out = run(
      'auth',
      new ForbiddenException({
        statusCode: 403,
        message: 'Kurier faol emas',
        code: CARRIER_ERROR_CODES.COURIER_INACTIVE,
      }),
    );
    expect(out).toMatchObject({
      status: 403,
      body: {
        name: 'Forbidden',
        code: 0,
        status: 403,
        error_code: 'CARRIER_COURIER_INACTIVE',
      },
    });
  });

  it('429 va RPC timeout (504) to‘g‘ri holatga tushadi', () => {
    expect(run('auth', new ThrottlerException()).status).toBe(429);
    const timeout = run('result', new TimeoutError());
    expect(timeout.status).toBe(504);
    expect(timeout.body).toMatchObject({ success: false, status: 504 });
  });

  it('quyi servis RPC xatosi (oddiy obyekt) — holati saqlanadi', () => {
    expect(
      run('result', { statusCode: 404, message: 'Order not found' }),
    ).toMatchObject({
      status: 200,
      body: { success: false, msg: 'Order not found', status: 404 },
    });
  });
});
