import 'reflect-metadata';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import {
  defer,
  map,
  NEVER,
  type Observable,
  of,
  throwError,
  timer,
} from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import type { AiStatusPoller } from './ai/ai-status.poller';

/** Nest route metadata'si metod funksiyasining o'zida saqlanadi. */
const handlerOf = (name: keyof OrderGatewayController): object =>
  Object.getOwnPropertyDescriptor(OrderGatewayController.prototype, name)
    ?.value as object;

/**
 * POST /orders/ai-parse (NsxoDSmm #1-12, Gy8Lt6KT #1-3, bVeyEuIR #3,
 * HD5zOyBp #4/#5/#9/#11/#12).
 *
 * Kontroller `{ send: jest.fn() }` soxta mijozlar bilan pozitsion quriladi;
 * RMQ kechikishi rxjs `timer`/`NEVER` va jest soxta taymerlari bilan
 * simulyatsiya qilinadi.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** jest asimmetrik matcher'lari `any` qaytaradi — `unknown` ga toraytiriladi. */
const anyUuid = (): unknown => expect.stringMatching(UUID_RE);
const anyNumber = (): unknown => expect.any(Number);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

const image = (buffer: Buffer, mimetype = 'image/jpeg') => ({
  originalname: 'buyurtma.jpg',
  mimetype,
  size: buffer.length,
  buffer,
});

const SECRET_PHONE = '+998901234567';
const SECRET_TEXT = `Ali ${SECRET_PHONE} Chilonzor 5-uy, 2 ta atir 150 ming`;

const RAW_ORDER = {
  customer_name: 'Ali',
  phone_number: SECRET_PHONE,
  extra_number: null,
  region_name: 'Toshkent shahri',
  district_name: 'Chilonzor',
  address: 'Chilonzor 5-uy',
  full_address: null,
  items: [{ name: 'atir', quantity: 2 }],
  total_price: 150000,
  comment: null,
  where_deliver: 'center',
  is_replacement: false,
  operator: null,
};

const PREVIEW = {
  index: 0,
  ready: true,
  issues: [],
  customer_name: 'Ali',
  phone_number: SECRET_PHONE,
  extra_number: null,
  region_id: '1',
  region_name: 'Toshkent shahri',
  region_given: true,
  district_id: '12',
  district_name: 'Chilonzor',
  district_candidates: [],
  address: 'Chilonzor 5-uy',
  items: [
    {
      name: 'atir',
      quantity: 2,
      product_id: '15',
      resolved_name: 'Atir 50 ml',
      candidates: [],
      unresolved: false,
    },
  ],
  total_price: 150000,
  price_confirmed: false,
  where_deliver: 'center',
  comment: null,
  is_replacement: false,
  operator: null,
};

type Pattern = { cmd: string };

/** Soxta RMQ mijozlariga kelgan payload (testlar o'qiydigan maydonlar). */
type SendPayload = {
  text?: string;
  images?: Array<{ media_type: string; data_base64: string }>;
  raw_orders?: unknown[];
  market_id?: string;
  requester?: { id: string; roles: string[] };
  request_id?: string;
  trace_id?: string | null;
  draft_id?: string;
  deadline_at?: number;
  id?: string;
};

type Fake = { send: jest.Mock<Observable<unknown>, [Pattern, SendPayload]> };

const fakeClient = (): Fake => ({
  send: jest.fn<Observable<unknown>, [Pattern, SendPayload]>(),
});
const asClient = (fake: Fake) => fake as unknown as ClientProxy;

const makeController = (
  opts: { enabled?: unknown; withAi?: boolean; withPoller?: boolean } = {},
) => {
  const order = fakeClient();
  const identity = fakeClient();
  const logistics = fakeClient();
  const branch = fakeClient();
  const file = fakeClient();
  const ai = fakeClient();
  const catalog = fakeClient();
  const config = {
    get: jest.fn((key: string) =>
      key === 'AI_ORDER_ENABLED' ? (opts.enabled ?? true) : undefined,
    ),
  };
  const poller = { getState: jest.fn(() => 'enabled') };
  const controller = new OrderGatewayController(
    asClient(order),
    asClient(identity),
    asClient(logistics),
    asClient(branch),
    asClient(file),
    opts.withAi === false ? undefined : asClient(ai),
    asClient(catalog),
    config as unknown as ConfigService,
    opts.withPoller === false
      ? undefined
      : (poller as unknown as AiStatusPoller),
  );
  return {
    controller,
    order,
    identity,
    logistics,
    branch,
    file,
    ai,
    catalog,
    config,
    poller,
  };
};

const marketReq = (sub = '77') => ({
  user: { sub, username: 'market', roles: ['market'] },
});
const adminReq = {
  user: { sub: '1', username: 'admin', roles: ['admin'] },
};
const operatorReq = {
  user: { sub: '501', username: 'op', roles: ['market_operator'] },
};

const okExtract = () => of({ ok: true, orders: [RAW_ORDER] });
const okPreview = () => of({ previews: [PREVIEW] });

const allSends = (fakes: Fake[]) =>
  fakes.reduce((total, fake) => total + fake.send.mock.calls.length, 0);

describe('OrderGatewayController — POST /orders/ai-parse', () => {
  beforeEach(() => {
    // Kutilgan WARN'lar (timeout/ai_error) test chiqishini to'ldirmasin;
    // MAXFIYLIK testi o'z spy'i bilan ularning MAZMUNINI tekshiradi.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('dekoratorlar (C8)', () => {
    const handler = handlerOf('aiParse');

    it('HTTP 200, UserThrottlerGuard ulangan, 6 ta rol', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
        UserThrottlerGuard,
      );
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(
        expect.arrayContaining([
          'superadmin',
          'admin',
          'registrator',
          'manager',
          'market',
          'market_operator',
        ]),
      );
    });

    it('@Throttle / @SkipThrottle YO‘Q — global per-IP limit o‘zgarmaydi', () => {
      const throttlerKeys = Reflect.getMetadataKeys(handler).filter((key) =>
        String(key).startsWith('THROTTLER:'),
      );
      expect(throttlerKeys).toEqual([]);
    });

    it('MAXFIYLIK: rasm faqat RAM’da — multer storage MemoryStorage (modul `dest` bersa ham)', () => {
      type MulterMixin = new (moduleOptions?: object) => {
        multer: { storage: object };
      };
      const interceptors = Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        handler,
      ) as MulterMixin[];
      expect(interceptors).toHaveLength(1);
      // MulterModule global `dest` bergan taqdirda ham lokal memoryStorage ustun.
      const interceptor = new interceptors[0]({
        dest: '/tmp/ai-parse-yozilmasin',
      });
      expect(interceptor.multer.storage.constructor.name).toBe('MemoryStorage');
    });

    it('ai-availability `:id` dan OLDIN e’lon qilingan', () => {
      const names = Object.getOwnPropertyNames(
        OrderGatewayController.prototype,
      );
      expect(names.indexOf('aiAvailability')).toBeGreaterThan(-1);
      expect(names.indexOf('aiAvailability')).toBeLessThan(
        names.indexOf('findById'),
      );
    });
  });

  describe('o‘chirgich (bVeyEuIR #3)', () => {
    it('AI_ORDER_ENABLED=false → 200 {ok:false, reason:"disabled"}, AI chaqirilmaydi', async () => {
      const { controller, ai, order } = makeController({ enabled: false });
      const res = await controller.aiParse(
        { text: SECRET_TEXT },
        [],
        marketReq(),
      );
      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual(
        expect.objectContaining({ ok: false, reason: 'disabled' }),
      );
      expect(typeof res.data.message).toBe('string');
      expect(ai.send).not.toHaveBeenCalled();
      expect(order.send).not.toHaveBeenCalled();
    });

    it("satr ko'rinishidagi 'false' ham o'chiq; AI mijozi yo'q bo'lsa ham disabled", async () => {
      const off = makeController({ enabled: 'false' });
      expect(
        (await off.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('disabled');

      const noAi = makeController({ withAi: false });
      expect(
        (await noAi.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('disabled');
    });
  });

  describe('kiritish validatsiyasi — Claude’ga BORMASDAN 400', () => {
    it('#1 matn ham, rasm ham yo‘q → 400, hech qanday RPC yo‘q', async () => {
      const fx = makeController();
      await expect(
        fx.controller.aiParse({ text: '   ' }, [], marketReq()),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        fx.controller.aiParse({}, undefined, marketReq()),
      ).rejects.toThrow('Matn yoki rasm yuboring');
      expect(
        allSends([fx.order, fx.identity, fx.ai, fx.file, fx.catalog]),
      ).toBe(0);
    });

    it('#2 4000 dan uzun matn → 400 (handler ham tekshiradi)', async () => {
      const fx = makeController();
      await expect(
        fx.controller.aiParse({ text: 'a'.repeat(4001) }, [], marketReq()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fx.ai.send).not.toHaveBeenCalled();
    });

    it('#3 4-rasm → 400; 2 MB dan katta rasm → 400', async () => {
      const fx = makeController();
      await expect(
        fx.controller.aiParse(
          {},
          [image(JPEG), image(JPEG), image(JPEG), image(JPEG)],
          marketReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const big = Buffer.alloc(2 * 1024 * 1024 + 1);
      JPEG.copy(big);
      await expect(
        fx.controller.aiParse({}, [image(big)], marketReq()),
      ).rejects.toThrow('Rasm 2 MB dan katta');
      expect(fx.ai.send).not.toHaveBeenCalled();
    });

    it('faqat JPEG/PNG: gif/webp/pdf turi → 400', async () => {
      const fx = makeController();
      for (const mime of ['image/gif', 'image/webp', 'application/pdf']) {
        await expect(
          fx.controller.aiParse({}, [image(JPEG, mime)], marketReq()),
        ).rejects.toThrow('Faqat JPEG yoki PNG rasm');
      }
      expect(fx.ai.send).not.toHaveBeenCalled();
    });

    it('#4 mazmuni PDF, lekin image/jpeg deb e’lon qilingan → 400 (imzo)', async () => {
      const fx = makeController();
      await expect(
        fx.controller.aiParse({}, [image(PDF, 'image/jpeg')], marketReq()),
      ).rejects.toThrow('Rasm fayli buzilgan yoki turi mos emas');
      // PNG deb e'lon qilingan JPEG ham rad etiladi.
      await expect(
        fx.controller.aiParse({}, [image(JPEG, 'image/png')], marketReq()),
      ).rejects.toThrow('Rasm fayli buzilgan yoki turi mos emas');
      expect(fx.ai.send).not.toHaveBeenCalled();
    });
  });

  describe('market server tomonda aniqlanadi (#6)', () => {
    it('MARKET: tanadagi market_id=999 E’TIBORSIZ, token sub ishlatiladi', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(okExtract());
      fx.order.send.mockReturnValue(okPreview());

      await fx.controller.aiParse(
        { text: SECRET_TEXT, market_id: '999' },
        [],
        marketReq('77'),
      );

      expect(fx.ai.send.mock.calls[0][1].market_id).toBe('77');
      expect(fx.order.send.mock.calls[0][1].market_id).toBe('77');
      expect(fx.identity.send).not.toHaveBeenCalled();
    });

    it('admin market_id’siz → 400 "market_id majburiy", AI chaqirilmaydi', async () => {
      const fx = makeController();
      await expect(
        fx.controller.aiParse({ text: SECRET_TEXT }, [], adminReq),
      ).rejects.toThrow('market_id majburiy');
      expect(fx.ai.send).not.toHaveBeenCalled();
    });

    it('admin market_id bilan — o‘sha market', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(okExtract());
      fx.order.send.mockReturnValue(okPreview());
      await fx.controller.aiParse(
        { text: SECRET_TEXT, market_id: '12' },
        [],
        adminReq,
      );
      expect(fx.ai.send.mock.calls[0][1].market_id).toBe('12');
    });

    it('MARKET_OPERATOR: identity user.market_id; tanadagi qiymat e’tiborsiz', async () => {
      const fx = makeController();
      fx.identity.send.mockReturnValue(of({ data: { market_id: '88' } }));
      fx.ai.send.mockReturnValue(okExtract());
      fx.order.send.mockReturnValue(okPreview());
      await fx.controller.aiParse(
        { text: SECRET_TEXT, market_id: '999' },
        [],
        operatorReq,
      );
      expect(fx.identity.send).toHaveBeenCalledWith(
        { cmd: 'identity.user.find_by_id' },
        { id: '501' },
      );
      expect(fx.ai.send.mock.calls[0][1].market_id).toBe('88');
    });

    it('MARKET_OPERATOR marketsiz → 200 {ok:false, reason:"no_market"}', async () => {
      const fx = makeController();
      fx.identity.send.mockReturnValue(of({ data: { market_id: null } }));
      const res = await fx.controller.aiParse(
        { text: SECRET_TEXT },
        [],
        operatorReq,
      );
      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual(
        expect.objectContaining({ ok: false, reason: 'no_market' }),
      );
      expect(fx.ai.send).not.toHaveBeenCalled();
    });
  });

  describe('muvaffaqiyatli oqim', () => {
    it('extract → preview → {ok:true, orders, draft_id} (bitta envelope)', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(okExtract());
      fx.order.send.mockReturnValue(okPreview());
      const before = Date.now();

      const res = await fx.controller.aiParse(
        { text: SECRET_TEXT },
        [],
        marketReq('77'),
      );

      expect(res).toEqual({
        statusCode: 200,
        message: 'success',
        data: {
          ok: true,
          orders: [PREVIEW],
          draft_id: anyUuid(),
        },
      });

      expect(fx.ai.send).toHaveBeenCalledTimes(1);
      const [pattern, payload] = fx.ai.send.mock.calls[0];
      expect(pattern).toEqual({ cmd: 'ai.order.extract' });
      expect(payload).toEqual({
        text: SECRET_TEXT,
        images: [],
        market_id: '77',
        requester: { id: '77', roles: ['market'] },
        trace_id: null,
        draft_id: res.data.draft_id,
        deadline_at: anyNumber(),
      });
      expect(payload.deadline_at).toBeGreaterThanOrEqual(before + 58_000);
      expect(payload.deadline_at).toBeLessThanOrEqual(Date.now() + 58_000);

      expect(fx.order.send).toHaveBeenCalledTimes(1);
      const [previewPattern, previewPayload] = fx.order.send.mock.calls[0];
      expect(previewPattern).toEqual({ cmd: 'order.ai_resolve_preview' });
      expect(previewPayload).toEqual({
        raw_orders: [RAW_ORDER],
        market_id: '77',
        requester: { id: '77', roles: ['market'] },
        request_id: anyUuid(),
        trace_id: null,
        draft_id: res.data.draft_id,
        deadline_at: anyNumber(),
      });
      expect(previewPayload.request_id).not.toBe(res.data.draft_id);
    });

    it('ekstraksiya bo‘sh → {ok:true, orders:[]} va preview CHAQIRILMAYDI', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(of({ ok: true, orders: [] }));
      const res = await fx.controller.aiParse(
        { text: 'salom' },
        [],
        marketReq(),
      );
      expect(res.data).toEqual({
        ok: true,
        orders: [],
        draft_id: anyUuid(),
      });
      expect(fx.order.send).not.toHaveBeenCalled();
    });

    it('#12 rasm base64 bo‘lib ai-service’ga ketadi; file.upload CHAQIRILMAYDI', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(okExtract());
      fx.order.send.mockReturnValue(okPreview());

      const res = await fx.controller.aiParse(
        {},
        [image(JPEG), image(PNG, 'image/png')],
        marketReq(),
      );

      expect(res.data.ok).toBe(true);
      expect(fx.ai.send.mock.calls[0][1].images).toEqual([
        { media_type: 'image/jpeg', data_base64: JPEG.toString('base64') },
        { media_type: 'image/png', data_base64: PNG.toString('base64') },
      ]);
      expect(fx.file.send).not.toHaveBeenCalled();
      const everyPattern = [fx.order, fx.identity, fx.ai, fx.catalog]
        .flatMap((fake) => fake.send.mock.calls)
        .map(([pattern]) => pattern.cmd);
      expect(everyPattern).not.toContain('file.upload');
    });
  });

  describe('timeout — qayta urinishsiz (#7/#8, Gy8Lt6KT #1-3)', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    });

    it('20 soniyalik AI javobi muvaffaqiyatli qaytadi (60s shift)', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(
        timer(20_000).pipe(map(() => ({ ok: true, orders: [RAW_ORDER] }))),
      );
      fx.order.send.mockReturnValue(okPreview());

      const pending = fx.controller.aiParse(
        { text: SECRET_TEXT },
        [],
        marketReq(),
      );
      await jest.advanceTimersByTimeAsync(20_000);
      const res = await pending;

      expect(res.data.ok).toBe(true);
      expect(res.data.orders).toEqual([PREVIEW]);
      // extract 20s → preview timeout = min(25s, 85s − 20s) = 25s.
      const previewPayload = fx.order.send.mock.calls[0][1];
      expect((previewPayload.deadline_at ?? NaN) - Date.now()).toBe(24_000);
    });

    it('65 soniyalik AI → 200 {ok:false, reason:"network"} (504 emas), send BIR marta', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(
        timer(65_000).pipe(map(() => ({ ok: true, orders: [RAW_ORDER] }))),
      );

      const pending = fx.controller.aiParse(
        { text: SECRET_TEXT },
        [],
        marketReq(),
      );
      await jest.advanceTimersByTimeAsync(60_000);
      const res = await pending;

      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual(
        expect.objectContaining({ ok: false, reason: 'network' }),
      );
      await jest.advanceTimersByTimeAsync(10_000);
      expect(fx.ai.send).toHaveBeenCalledTimes(1);
      expect(fx.order.send).not.toHaveBeenCalled();
    });

    it('ai-service umuman javob bermasa (NEVER) — 60s da network, send aynan 1 marta', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(NEVER);

      const pending = fx.controller.aiParse(
        { text: SECRET_TEXT },
        [],
        marketReq(),
      );
      await jest.advanceTimersByTimeAsync(59_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(res.data.reason).toBe('network');
      await jest.advanceTimersByTimeAsync(120_000);
      expect(fx.ai.send).toHaveBeenCalledTimes(1);
    });

    it('preview javob bermasa — 25s da network', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(okExtract());
      fx.order.send.mockReturnValue(NEVER);

      const pending = fx.controller.aiParse(
        { text: SECRET_TEXT },
        [],
        marketReq(),
      );
      await jest.advanceTimersByTimeAsync(25_000);
      const res = await pending;
      expect(res.data).toEqual(
        expect.objectContaining({ ok: false, reason: 'network' }),
      );
      expect(fx.order.send).toHaveBeenCalledTimes(1);
    });

    it('umumiy 85s byudjetdan preview uchun <5s qolsa order-service chaqirilmaydi', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(
        defer(() => {
          jest.setSystemTime(Date.now() + 81_000);
          return of({ ok: true, orders: [RAW_ORDER] });
        }),
      );
      const res = await fx.controller.aiParse(
        { text: SECRET_TEXT },
        [],
        marketReq(),
      );
      expect(res.data.reason).toBe('network');
      expect(fx.order.send).not.toHaveBeenCalled();
    });
  });

  describe('sabablar (#11, bVeyEuIR)', () => {
    it('truncated / network / disabled — uchta TURLI xabar', async () => {
      const messages: string[] = [];
      for (const reason of ['truncated', 'network', 'disabled']) {
        const fx = makeController();
        fx.ai.send.mockReturnValue(of({ ok: false, reason }));
        const res = await fx.controller.aiParse(
          { text: SECRET_TEXT },
          [],
          marketReq(),
        );
        expect(res.statusCode).toBe(200);
        expect(res.data).toEqual(
          expect.objectContaining({ ok: false, reason }),
        );
        expect(typeof res.data.message).toBe('string');
        const message = res.data.message ?? '';
        expect(message.length).toBeGreaterThan(0);
        messages.push(message);
        expect(fx.order.send).not.toHaveBeenCalled();
      }
      expect(new Set(messages).size).toBe(3);
    });

    it('invalid_json → ai_error; refused o‘zgarmaydi', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValueOnce(of({ ok: false, reason: 'invalid_json' }));
      expect(
        (await fx.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('ai_error');
      fx.ai.send.mockReturnValueOnce(of({ ok: false, reason: 'refused' }));
      expect(
        (await fx.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('refused');
    });

    it('cap_exceeded → scope va reset_at saqlanadi', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(
        of({
          ok: false,
          reason: 'cap_exceeded',
          scope: 'global',
          reset_at: '2026-09-28T00:00:00+05:00',
        }),
      );
      const res = await fx.controller.aiParse({ text: 'x' }, [], marketReq());
      expect(res.data).toEqual(
        expect.objectContaining({
          ok: false,
          reason: 'cap_exceeded',
          scope: 'global',
          reset_at: '2026-09-28T00:00:00+05:00',
        }),
      );
    });

    it('RPC xatosi (timeout emas) → ai_error; buzuq javob → ai_error', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValueOnce(throwError(() => new Error('boom')));
      expect(
        (await fx.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('ai_error');

      fx.ai.send.mockReturnValueOnce(of(null));
      expect(
        (await fx.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('ai_error');
    });

    it('preview xatosi yoki buzuq preview → ai_error', async () => {
      const fx = makeController();
      fx.ai.send.mockReturnValue(okExtract());
      fx.order.send.mockReturnValueOnce(
        throwError(() => new Error('order down')),
      );
      expect(
        (await fx.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('ai_error');

      fx.order.send.mockReturnValueOnce(of({ rows: [] }));
      expect(
        (await fx.controller.aiParse({ text: 'x' }, [], marketReq())).data
          .reason,
      ).toBe('ai_error');
    });
  });

  it('MAXFIYLIK: matn, telefon va rasm log’ga TUSHMAYDI (xato yo‘llarida ham)', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
    }
    const fx = makeController();
    fx.ai.send.mockReturnValueOnce(throwError(() => new Error(SECRET_TEXT)));
    await fx.controller.aiParse({ text: SECRET_TEXT }, [], marketReq());
    fx.ai.send.mockReturnValueOnce(okExtract());
    fx.order.send.mockReturnValueOnce(throwError(() => new Error('x')));
    await fx.controller.aiParse(
      { text: SECRET_TEXT },
      [image(JPEG)],
      marketReq(),
    );

    const all = logged.join('\n');
    expect(all).not.toContain(SECRET_PHONE);
    expect(all).not.toContain('Chilonzor');
    expect(all).not.toContain(JPEG.toString('base64'));
  });
});

describe('OrderGatewayController — GET /orders/ai-availability (HD5zOyBp #9)', () => {
  it('{enabled, state} — state poller keshidan', () => {
    const fx = makeController({ enabled: true });
    fx.poller.getState.mockReturnValue('cap_exceeded');
    expect(fx.controller.aiAvailability()).toEqual({
      statusCode: 200,
      message: 'success',
      data: { enabled: true, state: 'cap_exceeded' },
    });
  });

  it('o‘chirgich o‘chiq → enabled:false; poller yo‘q → state:"unknown"', () => {
    const fx = makeController({ enabled: false, withPoller: false });
    expect(fx.controller.aiAvailability().data).toEqual({
      enabled: false,
      state: 'unknown',
    });
  });
});
