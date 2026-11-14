import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Observable, of, throwError } from 'rxjs';
import { CARRIER_ERROR_CODES } from '@app/common';
import { CarrierGatewayController } from './carrier-gateway.controller';
import { carrierStatusRejected } from './carrier-status-body';
import {
  CarrierOrderStatus,
  CarrierOrderStatusRequestDto,
  CarrierOrderStatusWithRollbackRequestDto,
} from './dto/carrier.swagger.dto';

/** Sukut: rollback O'CHIQ (yangi akkaunt) — yoqiqni `ROLLBACK_ON` beradi. */
const CARRIER = {
  id: '3',
  name: 'BTS',
  courier_user_id: '55',
  rollback_enabled: false,
};
const ROLLBACK_ON = { ...CARRIER, rollback_enabled: true };
const COURIER_REQUESTER = { id: '55', roles: ['courier'], branch_id: null };
const KEY = { 'idempotency-key': '6f1c2a8e-4b7d-4c1e-9a3f-2d5b8e7c1a90' };

type Handler = (payload: any) => unknown;

function makeClient(handlers: Record<string, Handler>) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers[pattern.cmd];
      if (!handler) {
        return throwError(() => new Error(`unexpected cmd ${pattern.cmd}`));
      }
      try {
        const result = handler(payload);
        return result instanceof Observable ? result : of(result);
      } catch (error) {
        return throwError(() => error);
      }
    }),
  };
}

const order = (overrides: Record<string, unknown> = {}) => ({
  id: '900',
  order_number: 'E-900',
  qr_code_token: 'qr-900',
  status: 'waiting',
  courier_id: '55',
  holder_courier_id: '55',
  total_price: 200000,
  paid_online_amount: 50000,
  where_deliver: 'address',
  address: 'Chilonzor 5',
  comment: null,
  region_id: '1',
  district_id: '7',
  customer: { name: 'Ali', phone_number: '+998901112233', address: 'x' },
  region: {
    id: '1',
    name: 'Toshkent shahri',
    sato_code: '1726',
    districts: [],
  },
  district: {
    id: '7',
    name: 'Chilonzor',
    sato_code: '1726294',
    region_id: '1',
  },
  market: { id: '20', name: 'Shop', tariff_home: 30000 },
  branch: { id: '4', name: 'HQ' },
  courier_tariff: 25000,
  items: [{ id: '5501', product_id: '1', product_name: 'Kurtka', quantity: 2 }],
  createdAt: '2026-11-09T10:00:00.000Z',
  ...overrides,
});

/** Xom (boyitilmagan) `order.find_by_id` javobi. */
const raw = (overrides: Record<string, unknown> = {}) => {
  const full: Record<string, unknown> = order(overrides);
  for (const key of ['customer', 'region', 'district', 'market', 'branch']) {
    delete full[key];
  }
  return { statusCode: 200, data: full };
};

function makeController(handlers: {
  order?: Record<string, Handler>;
  logistics?: Record<string, Handler>;
  finance?: Record<string, Handler>;
  file?: Record<string, Handler>;
}) {
  const orderClient = makeClient(handlers.order ?? {});
  const logisticsClient = makeClient(handlers.logistics ?? {});
  const financeClient = makeClient(handlers.finance ?? {});
  const fileClient = handlers.file ? makeClient(handlers.file) : undefined;
  const controller = new CarrierGatewayController(
    orderClient as never,
    logisticsClient as never,
    financeClient as never,
    fileClient as never,
  );
  return {
    controller,
    orderClient,
    logisticsClient,
    financeClient,
    fileClient,
  };
}

const req = (headers: Record<string, unknown> = {}) => ({
  carrier: { ...CARRIER },
  headers,
});

const sentTo = (client: { send: jest.Mock }, cmd: string) =>
  client.send.mock.calls.find(([p]) => p.cmd === cmd)?.[1];

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return {
      type: (e as Error).constructor.name,
      body: (e as { getResponse?: () => unknown }).getResponse?.() as
        Record<string, unknown> | undefined,
    };
  }
};

describe('CarrierGatewayController.scan', () => {
  it('boshqa kurierning buyurtmasi -> 404, qabul qilinmaydi', async () => {
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({ courier_id: '77', holder_courier_id: '77' }),
        }),
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(logisticsClient.send).not.toHaveBeenCalled();
  });

  it('topilmagan QR (order-service 404) -> xuddi shu 404', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () =>
          throwError(() => ({
            statusCode: 404,
            message: 'Buyurtma topilmadi',
          })),
      },
    });
    await expect(
      controller.scan({ qr_token: 'nope' }, req()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('yo‘ldagi o‘z buyurtmasi -> kurier nomidan qabul; SOATO; ichki maydonlar yo‘q', async () => {
    let status = 'on the road';
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({ status }),
        }),
      },
      logistics: {
        'logistics.post.receive_order': () => {
          status = 'waiting';
          return { statusCode: 200, data: {} };
        },
      },
    });

    const res = (await controller.scan({ qr_token: ' qr-900 ' }, req())) as {
      data: { received: boolean; order: Record<string, unknown> };
    };

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.receive_order' },
      { id: '900', requester: COURIER_REQUESTER },
    );
    expect(res.data.received).toBe(true);
    expect(res.data.order).toMatchObject({
      id: '900',
      status: 'waiting',
      total_price: 200000,
      paid_online_amount: 50000,
      cod_amount: 150000,
      customer: { name: 'Ali', phone_number: '+998901112233' },
      market: { id: '20', name: 'Shop' },
      replacement: null,
      items: [{ id: '5501', product_id: '1', name: 'Kurtka', quantity: 2 }],
    });
    // Viloyat/tuman obyektida nom YO'Q — faqat id + SOATO.
    expect(res.data.order.region).toEqual({ id: '1', soato_code: '1726' });
    expect(res.data.order.district).toEqual({ id: '7', soato_code: '1726294' });
    const json = JSON.stringify(res.data.order);
    expect(json).not.toContain('tariff_home');
    expect(json).not.toContain('courier_tariff');
    expect(json).not.toContain('branch');
    expect(json).not.toContain('Toshkent shahri');
  });

  it('qabuldan keyin qayta o‘qish yiqilsa — 5xx emas, status waiting bilan javob', async () => {
    let calls = 0;
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => {
          calls += 1;
          if (calls > 1) return throwError(() => new Error('timeout'));
          return { statusCode: 200, data: order({ status: 'on the road' }) };
        },
      },
      logistics: {
        'logistics.post.receive_order': () => ({ statusCode: 200 }),
      },
    });
    const res = (await controller.scan({ qr_token: 'qr-900' }, req())) as {
      data: { received: boolean; order: { status: string } };
    };
    expect(res.data.received).toBe(true);
    expect(res.data.order.status).toBe('waiting');
  });

  it('⭐ geo boyitish yetmasa (SOATO yo‘q) -> qayta o‘qiydi, baribir yo‘q -> 503', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({ region: null, district: null }),
        }),
      },
    });
    const err = await errorOf(controller.scan({ qr_token: 'qr-900' }, req()));
    expect(err?.type).toBe(ServiceUnavailableException.name);
    expect(err?.body).toMatchObject({
      code: CARRIER_ERROR_CODES.TEMPORARILY_UNAVAILABLE,
    });
  });

  it('⭐ waiting_customer ham qabul qilinadi (could-not-deliver dan keyin)', async () => {
    let status = 'waiting_customer';
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({ status }),
        }),
      },
      logistics: {
        'logistics.post.receive_order': () => {
          status = 'waiting';
          return { statusCode: 200 };
        },
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).resolves.toMatchObject({
      data: { received: true, order: { status: 'waiting' } },
    });
    expect(logisticsClient.send).toHaveBeenCalled();
  });

  it('⭐ qabuldan keyin ma’lumot to‘liq emas -> 200 received:true, order:null (503 emas)', async () => {
    let calls = 0;
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => {
          calls += 1;
          return {
            statusCode: 200,
            data: order(
              calls === 1
                ? { status: 'on the road', region: null }
                : { status: 'waiting', region: null },
            ),
          };
        },
      },
      logistics: {
        'logistics.post.receive_order': () => ({ statusCode: 200 }),
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).resolves.toMatchObject({
      data: { received: true, order: null, refreshed: false },
    });
  });

  it('mijoz boyitilmagan (identity uzildi) -> 503, ismsiz/telefonsiz javob yo‘q', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({
            customer_id: '31',
            customer: { address: 'x', district: null },
          }),
        }),
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('noto‘g‘ri (eski) SOATO qiymati -> soato_code: null', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({
            district: { id: '7', name: 'X', sato_code: 'REG-01-DIS-02' },
          }),
        }),
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).resolves.toMatchObject({
      data: { order: { district: { id: '7', soato_code: null } } },
    });
  });

  it('⭐ parallel skan: logistics 400 order_not_receivable -> qayta o‘qiydi, 200 received:false', async () => {
    let calls = 0;
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => {
          calls += 1;
          return {
            statusCode: 200,
            data: order({ status: calls === 1 ? 'on the road' : 'waiting' }),
          };
        },
      },
      logistics: {
        'logistics.post.receive_order': () =>
          throwError(() => ({
            statusCode: 400,
            message: "Buyurtma yo'lda emas — qabul qilib bo'lmaydi",
            data: { reason: 'order_not_receivable' },
          })),
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).resolves.toMatchObject({
      data: { received: false, order: { status: 'waiting' } },
    });
    expect(calls).toBe(2);
  });

  it('qabulning boshqa 400 xatosi yutilmaydi', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({ status: 'on the road' }),
        }),
      },
      logistics: {
        'logistics.post.receive_order': () =>
          throwError(() => ({ statusCode: 400, message: 'boshqa xato' })),
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).rejects.toMatchObject({ statusCode: 400, message: 'boshqa xato' });
  });

  it('waiting holatdagi buyurtma -> qayta qabul qilinmaydi (idempotent)', async () => {
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({ statusCode: 200, data: order() }),
      },
    });
    const res = (await controller.scan({ qr_token: 'qr-900' }, req())) as {
      data: { received: boolean };
    };
    expect(res.data.received).toBe(false);
    expect(logisticsClient.send).not.toHaveBeenCalled();
  });

  it('almashtirish buyurtmasi -> replacement.old_item_required', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({
            replacement_of_order_id: '880',
            replacement_state: 'awaiting_old_pickup',
          }),
        }),
      },
    });
    const res = (await controller.scan({ qr_token: 'qr-900' }, req())) as {
      data: { order: { replacement: unknown } };
    };
    expect(res.data.order.replacement).toEqual({
      of_order_id: '880',
      old_item_required: true,
    });
  });

  it('posilka kurier qo‘lida (holder) bo‘lsa ham ko‘rinadi', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_qr_enriched': () => ({
          statusCode: 200,
          data: order({
            status: 'cancelled',
            courier_id: null,
            holder_courier_id: '55',
          }),
        }),
      },
    });
    await expect(
      controller.scan({ qr_token: 'qr-900' }, req()),
    ).resolves.toMatchObject({ data: { order: { status: 'cancelled' } } });
  });
});

describe('CarrierGatewayController.updateStatus', () => {
  /** before — amaldan oldingi xom holat, after — amaldan keyingi boyitilgan holat. */
  /**
   * `order.find_by_id` (xom) 2 marta: amaldan OLDIN (`before`) va KEYIN
   * (eski kalit tekshiruvi — `afterRaw`, sukut: `after` ning holati).
   */
  const setup = (
    before: Record<string, unknown> = {},
    after: Record<string, unknown> | Error = { status: 'sold' },
    actions: Record<string, Handler> = {},
    afterRaw?: Record<string, unknown> | Error,
  ) => {
    let rawCalls = 0;
    const afterRawRow =
      afterRaw ??
      (after instanceof Error ? { ...before } : { ...before, ...after });
    return makeController({
      order: {
        'order.find_by_id': () => {
          rawCalls += 1;
          if (rawCalls === 1) return raw(before);
          return afterRawRow instanceof Error
            ? throwError(() => afterRawRow)
            : raw(afterRawRow);
        },
        'order.find_by_id_enriched': () =>
          after instanceof Error ? throwError(() => after) : order(after),
        'order.sell': () => ({ statusCode: 200, data: {} }),
        'order.partly_sell': () => ({ statusCode: 200, data: {} }),
        'order.cancel': () => ({ statusCode: 200, data: {} }),
        'order.rollback_waiting': () => ({ statusCode: 200, data: {} }),
        ...actions,
      },
    });
  };

  it('⭐ Idempotency-Key yo‘q -> 400 CARRIER_IDEMPOTENCY_KEY_REQUIRED, amal yo‘q', async () => {
    const { controller, orderClient } = setup();
    const err = await errorOf(
      controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(),
      ),
    );
    expect(err?.type).toBe(BadRequestException.name);
    expect(err?.body).toMatchObject({
      code: CARRIER_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    });
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('sold -> order.sell kurier nomidan, barqaror request_id, refreshed: true', async () => {
    const { controller, orderClient } = setup();
    const res = (await controller.updateStatus(
      '900',
      { status: CarrierOrderStatus.SOLD, comment: 'ok' },
      undefined,
      req(KEY),
    )) as { data: { order: { status: string }; refreshed: boolean } };
    const payload = sentTo(orderClient, 'order.sell');
    expect(payload).toMatchObject({
      id: '900',
      requester: COURIER_REQUESTER,
      dto: { comment: 'ok', proofFileKeys: [], proofFileKeysVerified: false },
    });
    expect(payload.request_id).toMatch(/^idem:55:[0-9a-f]{64}$/);
    expect(payload.dto).not.toHaveProperty('extraCost');
    expect(payload.dto).not.toHaveProperty('paidAmount');
    expect(res.data).toMatchObject({
      refreshed: true,
      order: { status: 'sold' },
    });
  });

  it('partly_sold -> order.partly_sell (order_item_info + totalPrice)', async () => {
    const { controller, orderClient } = setup();
    await controller.updateStatus(
      '900',
      {
        status: CarrierOrderStatus.PARTLY_SOLD,
        total_price: 100000,
        items: [{ order_item_id: '5501', quantity: 1 }],
      },
      undefined,
      req(KEY),
    );
    expect(sentTo(orderClient, 'order.partly_sell')).toMatchObject({
      id: '900',
      requester: COURIER_REQUESTER,
      dto: {
        order_item_info: [{ order_item_id: '5501', quantity: 1 }],
        totalPrice: 100000,
      },
    });
  });

  it('cancelled -> order.cancel (reason)', async () => {
    const { controller, orderClient } = setup({}, { status: 'cancelled' });
    await controller.updateStatus(
      '900',
      {
        status: CarrierOrderStatus.CANCELLED,
        reason: 'CUSTOMER_REFUSED' as never,
      },
      undefined,
      req(KEY),
    );
    expect(sentTo(orderClient, 'order.cancel')).toMatchObject({
      requester: COURIER_REQUESTER,
      dto: { reason: 'CUSTOMER_REFUSED' },
    });
  });

  it('rollback (akkauntda yoqiq) -> order.rollback_waiting (target waiting)', async () => {
    const { controller, orderClient } = setup(
      { status: 'sold' },
      { status: 'waiting' },
    );
    await controller.updateStatus(
      '900',
      { status: CarrierOrderStatus.ROLLBACK },
      undefined,
      { carrier: { ...ROLLBACK_ON }, headers: KEY },
    );
    expect(sentTo(orderClient, 'order.rollback_waiting')).toMatchObject({
      id: '900',
      requester: COURIER_REQUESTER,
      dto: { target_status: 'waiting' },
    });
  });

  it('⭐ rollback (akkauntda o‘chiq) -> noma’lum status bilan AYNI 400, hech qanday chaqiruv yo‘q', async () => {
    // Pipe chetlab o'tilgandagi himoya: buyurtma o'qilmaydi, kalit/RMQ amali yo'q.
    for (const headers of [KEY, {}]) {
      const { controller, orderClient, logisticsClient, financeClient } = setup(
        { status: 'sold' },
        { status: 'waiting' },
      );
      const err = await errorOf(
        controller.updateStatus(
          'not-an-id',
          { status: CarrierOrderStatus.ROLLBACK },
          { mimetype: 'image/png', size: 1 } as never,
          req(headers),
        ),
      );
      expect(err?.type).toBe(BadRequestException.name);
      expect(err?.body).toEqual(carrierStatusRejected().getResponse());
      expect(err?.body).toEqual({
        message: [
          "status: quyidagilardan biri bo'lishi kerak: sold, partly_sold, cancelled",
        ],
        error: 'Bad Request',
        statusCode: 400,
      });
      expect(JSON.stringify(err?.body)).not.toMatch(/rollback/i);
      expect(orderClient.send).not.toHaveBeenCalled();
      expect(logisticsClient.send).not.toHaveBeenCalled();
      expect(financeClient.send).not.toHaveBeenCalled();
    }
  });

  it('⭐ eski kalit bilan jim takror (holat o‘zgarmadi) -> 409 IDEMPOTENCY_KEY_STALE', async () => {
    // sold → rollback → sold: order-service eski natijani qaytaradi, buyurtma waiting qoladi.
    const { controller } = setup({ status: 'waiting' }, { status: 'waiting' });
    const err = await errorOf(
      controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    );
    expect(err?.type).toBe(ConflictException.name);
    expect(err?.body).toMatchObject({
      code: CARRIER_ERROR_CODES.IDEMPOTENCY_KEY_STALE,
    });
  });

  it('ayni urinishning qonuniy takrori (allaqachon sold) -> 200', async () => {
    const { controller } = setup({ status: 'sold' }, { status: 'sold' });
    await expect(
      controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    ).resolves.toMatchObject({ data: { refreshed: true } });
  });

  it('⭐ amaldan keyin qayta o‘qish yiqilsa -> 200 { order: null, refreshed: false } (5xx emas)', async () => {
    const { controller } = setup(
      {},
      new Error('timeout'),
      {},
      {
        status: 'sold',
      },
    );
    await expect(
      controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      data: { order: null, refreshed: false },
    });
  });

  it('⭐ quyi oqim 404 (kurier/market qidiruvi uzildi) -> 503; qator mos emas -> 400', async () => {
    const down = setup(
      {},
      { status: 'sold' },
      {
        'order.sell': () =>
          throwError(() => ({ statusCode: 404, message: 'Kuryer topilmadi' })),
      },
    );
    const err = await errorOf(
      down.controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    );
    expect(err?.type).toBe(ServiceUnavailableException.name);
    expect(err?.body).toMatchObject({
      code: CARRIER_ERROR_CODES.TEMPORARILY_UNAVAILABLE,
    });

    const item = setup(
      {},
      { status: 'sold' },
      {
        'order.partly_sell': () =>
          throwError(() => ({
            statusCode: 404,
            message: 'Order item not found in order: 1',
          })),
      },
    );
    await expect(
      item.controller.updateStatus(
        '900',
        {
          status: CarrierOrderStatus.PARTLY_SOLD,
          total_price: 1,
          items: [{ order_item_id: '1', quantity: 1 }],
        },
        undefined,
        req(KEY),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⭐ boyitish yiqilsa ham eski kalit aniqlanadi (xom o‘qish) -> 409', async () => {
    const { controller } = setup(
      { status: 'waiting' },
      new Error('logistics down'),
      {},
      { status: 'waiting' },
    );
    const err = await errorOf(
      controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    );
    expect(err?.body).toMatchObject({
      code: CARRIER_ERROR_CODES.IDEMPOTENCY_KEY_STALE,
    });
  });

  it('xom qayta o‘qish ham yiqilsa -> 503 (ayni kalit bilan takror xavfsiz)', async () => {
    const { controller } = setup({}, { status: 'sold' }, {}, new Error('db'));
    await expect(
      controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('⭐ qaytarilgan posilkada `cancelled` ning ayni kalitli takrori -> 200 (404 emas)', async () => {
    const returned = {
      status: 'cancelled (sent)',
      courier_id: null,
      holder_courier_id: null,
      canceled_post_id: '77',
    };
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_id': () => raw(returned),
        'order.find_by_id_enriched': () => order(returned),
        'order.cancel': () => ({ statusCode: 200, data: {} }),
      },
      logistics: {
        'logistics.post.find_by_ids': () => ({
          statusCode: 200,
          data: [{ id: '77', courier_id: '55' }],
        }),
      },
    });
    await expect(
      controller.updateStatus(
        '900',
        {
          status: CarrierOrderStatus.CANCELLED,
          reason: 'CUSTOMER_REFUSED' as never,
        },
        undefined,
        req(KEY),
      ),
    ).resolves.toMatchObject({
      data: { refreshed: true, order: { status: 'cancelled (sent)' } },
    });
    expect(logisticsClient.send).toHaveBeenCalled();
  });

  it('BIGINT’dan katta id -> 400 (500 + requeue emas)', async () => {
    const { controller, orderClient } = setup();
    await expect(
      controller.updateStatus(
        '9223372036854775808',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('begona buyurtma -> 404, hech qanday amal yuborilmaydi', async () => {
    const { controller, orderClient } = setup({
      courier_id: '77',
      holder_courier_id: '77',
    });
    await expect(
      controller.updateStatus(
        '900',
        { status: CarrierOrderStatus.SOLD },
        undefined,
        req(KEY),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sentTo(orderClient, 'order.sell')).toBeUndefined();
  });

  it('noto‘g‘ri id (harf / yetakchi nol) -> 400', async () => {
    const { controller } = setup();
    for (const bad of ['abc', '0123']) {
      await expect(
        controller.updateStatus(
          bad,
          { status: CarrierOrderStatus.SOLD },
          undefined,
          req(KEY),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('⭐ isbot fayli: turi/hajmi mos emas -> 400, yuklanmaydi va amal yo‘q', async () => {
    const file = (mimetype: string, size: number) => ({
      originalname: 'p',
      mimetype,
      buffer: Buffer.alloc(size),
    });
    for (const proof of [
      file('image/heic', 10),
      file('image/jpeg', 11 * 1024 * 1024),
    ]) {
      const { controller, orderClient, fileClient } = makeController({
        order: { 'order.find_by_id': () => raw() },
        file: { 'file.upload': () => ({ data: { key: 'k1' } }) },
      });
      await expect(
        controller.updateStatus(
          '900',
          { status: CarrierOrderStatus.SOLD },
          proof,
          req(KEY),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fileClient?.send).not.toHaveBeenCalled();
      expect(sentTo(orderClient, 'order.sell')).toBeUndefined();
    }
  });
});

describe('CarrierGatewayController.returns', () => {
  it('sizdagi cancelled posilkalar -> logistics.post.cancel.create kurier nomidan', async () => {
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_id': ({ id }) =>
          raw({ id, status: 'cancelled', courier_id: null }),
      },
      logistics: {
        'logistics.post.cancel.create': () => ({
          statusCode: 200,
          data: { post_id: 77, order_ids: ['901', '905'] },
        }),
      },
    });
    const res = await controller.returns(
      { order_ids: ['901', '905', '901'] },
      req(),
    );
    expect(sentTo(logisticsClient, 'logistics.post.cancel.create')).toEqual({
      dto: { order_ids: ['901', '905'] },
      requester: COURIER_REQUESTER,
    });
    expect(res).toMatchObject({
      data: { post_id: '77', order_ids: ['901', '905'] },
    });
  });

  it('begona -> 404 (id’lar bilan); cancelled emas -> 400; pochta ochilmaydi', async () => {
    const foreign = makeController({
      order: {
        'order.find_by_id': () =>
          raw({
            status: 'cancelled',
            courier_id: '77',
            holder_courier_id: '77',
          }),
      },
    });
    await expect(
      foreign.controller.returns({ order_ids: ['901'] }, req()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.logisticsClient.send).not.toHaveBeenCalled();

    const waiting = makeController({
      order: { 'order.find_by_id': () => raw({ status: 'waiting' }) },
    });
    await expect(
      waiting.controller.returns({ order_ids: ['900'] }, req()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⭐ takror: allaqachon O‘Z qaytarish pochtasida -> o‘sha post_id, yangi pochta yo‘q', async () => {
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_id': () =>
          raw({
            status: 'cancelled (sent)',
            courier_id: null,
            holder_courier_id: null,
            canceled_post_id: '77',
          }),
      },
      logistics: {
        'logistics.post.find_by_ids': () => ({
          statusCode: 200,
          data: [{ id: '77', courier_id: '55' }],
        }),
      },
    });
    await expect(
      controller.returns({ order_ids: ['901'] }, req()),
    ).resolves.toMatchObject({ data: { post_id: '77' } });
    expect(
      sentTo(logisticsClient, 'logistics.post.cancel.create'),
    ).toBeUndefined();
  });

  it('filial qabul qilgan (cancelled, egasi filial) o‘z qaytarishi -> takror xavfsiz', async () => {
    const { controller, logisticsClient } = makeController({
      order: {
        'order.find_by_id': () =>
          raw({
            status: 'cancelled',
            courier_id: null,
            holder_courier_id: null,
            canceled_post_id: '77',
          }),
      },
      logistics: {
        'logistics.post.find_by_ids': () => ({
          statusCode: 200,
          data: [{ id: '77', courier_id: '55' }],
        }),
      },
    });
    await expect(
      controller.returns({ order_ids: ['901'] }, req()),
    ).resolves.toMatchObject({ data: { post_id: '77' } });
    expect(
      sentTo(logisticsClient, 'logistics.post.cancel.create'),
    ).toBeUndefined();
  });

  it('BIGINT’dan katta id -> 400', async () => {
    const { controller, orderClient } = makeController({});
    await expect(
      controller.returns({ order_ids: ['9223372036854775808'] }, req()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('boshqa kurierning qaytarish pochtasidagi posilka -> 404', async () => {
    const { controller } = makeController({
      order: {
        'order.find_by_id': () =>
          raw({
            status: 'cancelled (sent)',
            courier_id: null,
            holder_courier_id: null,
            canceled_post_id: '78',
          }),
      },
      logistics: {
        'logistics.post.find_by_ids': () => ({
          statusCode: 200,
          data: [{ id: '78', courier_id: '77' }],
        }),
      },
    });
    await expect(
      controller.returns({ order_ids: ['901'] }, req()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CarrierGatewayController.listOrders / cashbox', () => {
  it('ro‘yxat faqat shu kurier doirasida, begona qator filtrlanadi', async () => {
    const { controller, orderClient } = makeController({
      order: {
        'order.find_all_enriched': () => ({
          data: [
            order(),
            order({ id: '901', courier_id: '77', holder_courier_id: '77' }),
          ],
          total: 2,
        }),
      },
    });
    const res = (await controller.listOrders(
      { status: 'waiting,sold', from: '2026-11-01', page: 1, limit: 10 },
      req(),
    )) as { data: { items: Array<{ id: string }> } };

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.find_all_enriched' },
      {
        query: {
          courier_ids: ['55'],
          status: ['waiting', 'sold'],
          start_day: '2026-11-01',
          page: 1,
          limit: 10,
        },
      },
    );
    expect(res.data.items.map((o) => o.id)).toEqual(['900']);
  });

  it('noma’lum holat -> 400; geo yetmasa -> 503', async () => {
    const { controller } = makeController({
      order: {
        'order.find_all_enriched': () => ({
          data: [order({ district: null })],
          total: 1,
        }),
      },
    });
    await expect(
      controller.listOrders({ status: 'delivered' }, req()),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.listOrders({}, req())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('⭐ kassa: sukut oynasi oxirgi 30 kun (Toshkent kuni), o‘z FOR_COURIER kassasi', async () => {
    const { controller, financeClient } = makeController({
      finance: { 'finance.cashbox.my': () => ({ statusCode: 200, data: {} }) },
    });
    const res = (await controller.cashbox({}, req())) as {
      data: { from: string; to: string };
    };
    const payload = sentTo(financeClient, 'finance.cashbox.my');
    expect(payload).toMatchObject({
      user_id: '55',
      roles: ['courier'],
      cashbox_type: 'couriers',
    });
    const span =
      (Date.parse(payload.toDate) - Date.parse(payload.fromDate)) / 86_400_000;
    expect(span).toBe(29);
    expect(res.data).toMatchObject({
      from: payload.fromDate,
      to: payload.toDate,
    });
  });

  it('kassa: oraliq > 92 kun / from > to / mavjud bo‘lmagan sana -> 400', async () => {
    const { controller, financeClient } = makeController({});
    for (const q of [
      { from: '2026-01-01', to: '2026-11-01' },
      { from: '2026-11-10', to: '2026-11-01' },
      { from: '2026-02-31', to: '2026-03-01' },
    ]) {
      await expect(controller.cashbox(q, req())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(financeClient.send).not.toHaveBeenCalled();
  });

  it('kassa javobi — xodim ma’lumoti va ichki tokenlar chiqmaydi', async () => {
    const { controller } = makeController({
      finance: {
        'finance.cashbox.my': () => ({
          statusCode: 200,
          data: {
            cashbox: { id: '1', balance: 125000, user_id: '55', user: {} },
            income: 125000,
            outcome: 0,
            cashboxHistory: [
              {
                id: '7001',
                operation_type: 'income',
                source_type: 'sell',
                source_id: '900',
                amount: 125000,
                balance_after: 125000,
                payment_method: 'cash',
                comment: null,
                dedup_epoch: 'req:idem:55:abc',
                created_by_user: {
                  name: 'Menejer',
                  phone_number: '+998900000000',
                },
                createdAt: new Date('2026-11-09T12:30:00.000Z'),
              },
              {
                id: '7002',
                operation_type: 'expense',
                source_type: 'courier_payment',
                source_id: 'gw:5f2c-token',
                amount: 100000,
                balance_after: 25000,
                source_user: { name: 'Menejer', phone_number: '+998900000000' },
                createdAt: '2026-11-10T09:00:00.000Z',
              },
            ],
          },
        }),
      },
    });

    const res = (await controller.cashbox(
      { from: '2026-11-01', to: '2026-11-10' },
      req(),
    )) as {
      data: { balance: number; history: Array<Record<string, unknown>> };
    };
    expect(res.data).toMatchObject({ balance: 125000, income: 125000 });
    expect(res.data.history[0]).toEqual({
      id: '7001',
      type: 'income',
      source_type: 'sell',
      amount: 125000,
      balance_after: 125000,
      order_id: '900',
      payment_method: 'cash',
      comment: null,
      created_at: '2026-11-09T12:30:00.000Z',
    });
    // To'lov qatorida source_id — o'tkazma tokeni, buyurtma emas.
    expect(res.data.history[1].order_id).toBeNull();
    const json = JSON.stringify(res.data);
    expect(json).not.toContain('+998900000000');
    expect(json).not.toContain('Menejer');
    expect(json).not.toContain('dedup');
    expect(json).not.toContain('gw:5f2c-token');
  });
});

describe('CarrierOrderStatusRequestDto validatsiyasi', () => {
  const errorsOf = async (
    body: Record<string, unknown>,
    dtoClass:
      | typeof CarrierOrderStatusRequestDto
      | typeof CarrierOrderStatusWithRollbackRequestDto = CarrierOrderStatusRequestDto,
  ) => {
    const dto = plainToInstance(dtoClass, body);
    return validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  };
  const check = async (body: Record<string, unknown>) =>
    (await errorsOf(body)).map((e) => e.property);

  it('⭐ rollback: ochiq DTO’da noma’lum qiymat, rollback DTO’sida qabul; xabar faqat ochiq qiymatlar', async () => {
    const PUBLIC_ONLY =
      'status must be one of the following values: sold, partly_sold, cancelled';
    const statusMessages = async (
      body: Record<string, unknown>,
      dtoClass?: typeof CarrierOrderStatusRequestDto,
    ) =>
      (await errorsOf(body, dtoClass))
        .filter((e) => e.property === 'status')
        .flatMap((e) => Object.values(e.constraints ?? {}));

    // O'chiq (ochiq DTO): rollback = sould = 5 — AYNI xabar.
    for (const status of ['rollback', 'sould', 5, undefined]) {
      expect(await statusMessages({ status })).toEqual([PUBLIC_ONLY]);
    }
    // Yoqiq: rollback o'tadi, xato qiymat xabarida rollback baribir YO'Q.
    expect(
      await errorsOf(
        { status: 'rollback' },
        CarrierOrderStatusWithRollbackRequestDto,
      ),
    ).toEqual([]);
    expect(
      await statusMessages(
        { status: 'sould' },
        CarrierOrderStatusWithRollbackRequestDto,
      ),
    ).toEqual([PUBLIC_ONLY]);
    for (const status of ['sold', 'partly_sold', 'cancelled']) {
      expect(await statusMessages({ status })).toEqual([]);
    }
    expect(CarrierOrderStatusRequestDto.rollbackAllowed).toBe(false);
    expect(CarrierOrderStatusWithRollbackRequestDto.rollbackAllowed).toBe(true);
  });

  it('extraCost / paidAmount qabul qilinmaydi (v1)', async () => {
    expect(await check({ status: 'sold', extraCost: 5000 })).toContain(
      'extraCost',
    );
    expect(await check({ status: 'sold', paidAmount: 1 })).toContain(
      'paidAmount',
    );
  });

  it('cancelled reason’siz -> xato; sold — reason shart emas', async () => {
    expect(await check({ status: 'cancelled' })).toContain('reason');
    expect(await check({ status: 'sold' })).toEqual([]);
  });

  it('partly_sold items va total_price’siz -> xato', async () => {
    const props = await check({ status: 'partly_sold' });
    expect(props).toEqual(expect.arrayContaining(['items', 'total_price']));
  });

  it('⭐ multipart: takroriy `items` qismlari (har biri JSON obyekt) va bitta obyekt ham', async () => {
    expect(
      await check({
        status: 'partly_sold',
        total_price: '100000',
        items: [
          '{"order_item_id":"5501","quantity":"1"}',
          '{"order_item_id":"5502","quantity":"0"}',
        ],
      }),
    ).toEqual([]);
    expect(
      await check({
        status: 'partly_sold',
        total_price: '1',
        items: '{"order_item_id":"5501","quantity":1}',
      }),
    ).toEqual([]);
  });

  it('multipart: items JSON satri va total_price satri qabul qilinadi', async () => {
    expect(
      await check({
        status: 'partly_sold',
        total_price: '100000',
        items: '[{"order_item_id":"5501","quantity":"1"}]',
      }),
    ).toEqual([]);
  });
});
