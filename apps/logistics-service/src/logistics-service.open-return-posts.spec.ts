import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import type { ConfigService } from '@nestjs/config';
import { NEVER, Observable, Subject, of, throwError } from 'rxjs';
import { Order_status, Post_status, RmqService } from '@app/common';
import { LogisticsServiceController } from './logistics-service.controller';
import { LogisticsServiceService } from './logistics-service.service';
import type { DistrictResolverService } from './district-resolver/district-resolver.service';

/**
 * W2-RPC-01 (producer) — logistics.post.open_return_posts_for_courier.
 *
 * Kuryer ko'chirish/o'chirish tekshiruvi (branch-service loadCourierHoldings,
 * 5000 ms) uchun yengil o'qish. rejected_for_courier ni qayta ishlatish
 * qatlamlar qoidasini buzardi: u avval identity ni 5 s kutadi, keyin har bir
 * pochta uchun guruh (N² order.find_all) — ~10 s, chaqiruvchi esa 5 s kutadi.
 *
 * Kontrakt:
 * - faqat CANCELED + courier_id pochtalar; identity boyitish yo'q;
 * - order_quantity — pochtaning O'Z CANCELLED_SENT buyurtmalari (guruh EMAS);
 * - har bir pochtaga bitta order.find_all, parallel, 3500 ms dan;
 * - noto'g'ri courier_id — 400; boshqa har qanday xato — 503 (xom xato yo'q).
 */
const CMD = 'logistics.post.open_return_posts_for_courier';
const SUCCESS_MESSAGE = 'Kuryerning qabul qilinmagan bekor pochtalari';
const INVALID_COURIER_MESSAGE = "courier_id noto'g'ri";
const UNAVAILABLE_MESSAGE =
  "Bekor qilingan pochtalarni tekshirib bo'lmadi — birozdan so'ng qayta urinib ko'ring";

type Row = Record<string, unknown>;
type OrderSend = (
  pattern: { cmd: string },
  payload: { query?: Row },
) => Observable<unknown>;

// Bitta kuryerning uchta bekor pochtasi — findCanceledPostGroup uchun BITTA
// guruh (31, 32 bir filial/hudud; 33 da filial/hudud yo'q — hammasiga mos).
const courierPosts: Row[] = [
  {
    id: '31',
    courier_id: '209',
    branch_id: '10',
    region_id: '5',
    status: Post_status.CANCELED,
  },
  {
    id: '32',
    courier_id: '209',
    branch_id: '10',
    region_id: '5',
    status: Post_status.CANCELED,
  },
  {
    id: '33',
    courier_id: '209',
    branch_id: null,
    region_id: null,
    status: Post_status.CANCELED,
  },
];

const cancelledSent = (id: string): Row => ({
  id,
  status: Order_status.CANCELLED_SENT,
  total_price: 50000,
});

// 31 — 2 ta, 32 — bo'sh pochta, 33 — 1 ta. Guruh mantiqida har biri 3 olardi.
const ordersByPost: Record<string, Row[]> = {
  '31': [cancelledSent('901'), cancelledSent('902')],
  '32': [],
  '33': [cancelledSent('903')],
};

const findAllQuery = (postId: string): Row => ({
  canceled_post_id: postId,
  status: Order_status.CANCELLED_SENT,
  fetch_all: true,
  page: 1,
  limit: 100,
});

function setup(options?: {
  posts?: Row[];
  postFindError?: Error;
  orderSend?: OrderSend;
}) {
  const defaultOrderSend: OrderSend = (pattern, payload) => {
    if (pattern.cmd === 'order.find_all') {
      return of({
        statusCode: 200,
        data: {
          data: ordersByPost[String(payload.query?.canceled_post_id)] ?? [],
        },
      });
    }
    return of({});
  };
  const orderClient = {
    send: jest.fn(options?.orderSend ?? defaultOrderSend),
  };
  const identityClient = { send: jest.fn(() => of({ data: [] })) };
  const branchClient = { send: jest.fn(() => of({})) };
  const postRepo = {
    find: jest.fn(() =>
      options?.postFindError
        ? Promise.reject(options.postFindError)
        : Promise.resolve((options?.posts ?? []).map((post) => ({ ...post }))),
    ),
  };

  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    orderClient as any,
    branchClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
    { log: jest.fn().mockResolvedValue(undefined) } as any,
  );

  const findAllQueries = () =>
    orderClient.send.mock.calls
      .filter(([pattern]) => pattern.cmd === 'order.find_all')
      .map(([, payload]) => payload.query);

  return {
    service,
    orderClient,
    identityClient,
    branchClient,
    postRepo,
    findAllQueries,
  };
}

async function expectRpcError(
  promise: Promise<unknown>,
  statusCode: number,
  message: string,
) {
  try {
    await promise;
    throw new Error('Expected RpcException');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual({
      statusCode,
      message,
      data: null,
    });
  }
}

/** Natija kelguncha kutmasdan: settled bayrog'i bilan kuzatish. */
function track(promise: Promise<unknown>) {
  const state = { settled: false };
  const outcome = promise.then(
    () => {
      state.settled = true;
      return null;
    },
    (error: unknown) => {
      state.settled = true;
      return error;
    },
  );
  return { state, outcome };
}

describe('LogisticsServiceService.openReturnPostsForCourier', () => {
  it('pochta yo‘q — bo‘sh massiv; order ham, identity ham chaqirilmaydi', async () => {
    const { service, postRepo, orderClient, identityClient } = setup();

    const result = await service.openReturnPostsForCourier('209');

    expect(result).toEqual({
      statusCode: 200,
      message: SUCCESS_MESSAGE,
      data: [],
    });
    expect(postRepo.find).toHaveBeenCalledTimes(1);
    expect(postRepo.find).toHaveBeenCalledWith({
      where: { status: Post_status.CANCELED, courier_id: '209' },
      order: { createdAt: 'DESC' },
    });
    expect(orderClient.send).not.toHaveBeenCalled();
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it('har bir pochta O‘Z sonini oladi (guruh soni emas); bo‘sh pochta 0 bilan qoladi', async () => {
    const { service, postRepo, identityClient, findAllQueries } = setup({
      posts: courierPosts,
    });
    const groupSpy = jest.spyOn(service as any, 'findCanceledPostGroup');

    const result = await service.openReturnPostsForCourier('209');

    expect(result.statusCode).toBe(200);
    expect(result.message).toBe(SUCCESS_MESSAGE);
    expect(result.data).toStrictEqual([
      { id: '31', branch_id: '10', order_quantity: 2 },
      { id: '32', branch_id: '10', order_quantity: 0 },
      { id: '33', branch_id: null, order_quantity: 1 },
    ]);
    // Har bir pochtaga AYNAN bitta order.find_all — o'z canceled_post_id si bilan.
    expect(findAllQueries()).toEqual([
      findAllQuery('31'),
      findAllQuery('32'),
      findAllQuery('33'),
    ]);
    // Guruh mantiqi ishlatilmaydi: u har bir pochta uchun postRepo.find ni
    // qayta chaqirardi.
    expect(groupSpy).not.toHaveBeenCalled();
    expect(postRepo.find).toHaveBeenCalledTimes(1);
    // Identity boyitish yo'q.
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it('courier_id atrofidagi bo‘shliq olib tashlanadi', async () => {
    const { service, postRepo } = setup();

    await service.openReturnPostsForCourier(' 209 ');

    expect(postRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: Post_status.CANCELED, courier_id: '209' },
      }),
    );
  });

  it('order chaqiruvlari parallel: hammasi birinchi javobdan oldin yuboriladi', async () => {
    const replies = new Map<string, Subject<unknown>>();
    const { service, orderClient } = setup({
      posts: courierPosts,
      orderSend: (_pattern, payload) => {
        const reply = new Subject<unknown>();
        replies.set(String(payload.query?.canceled_post_id), reply);
        return reply.asObservable();
      },
    });

    const { state, outcome } = track(service.openReturnPostsForCourier('209'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(orderClient.send).toHaveBeenCalledTimes(3);
    expect([...replies.keys()]).toEqual(['31', '32', '33']);
    expect(state.settled).toBe(false);

    for (const [postId, reply] of replies) {
      reply.next({ data: { data: ordersByPost[postId] } });
      reply.complete();
    }
    await outcome;
    expect(state.settled).toBe(true);
  });

  it('har bir order chaqiruvi 3500 ms kutiladi (chaqiruvchining 5000 ms byudjetiga sig‘adi), keyin 503', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const { service, orderClient } = setup({
        posts: courierPosts,
        orderSend: () => NEVER,
      });

      const { state, outcome } = track(
        service.openReturnPostsForCourier('209'),
      );

      // Uch pochta parallel: jami ham 3500 ms (3 × 3500 emas).
      await jest.advanceTimersByTimeAsync(3499);
      expect(orderClient.send).toHaveBeenCalledTimes(3);
      expect(state.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const error = await outcome;

      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toEqual({
        statusCode: 503,
        message: UNAVAILABLE_MESSAGE,
        data: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('findOrders ning odatiy kutish vaqti boshqa chaqiruvchilar uchun 5000 ms qoladi', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const { service } = setup({ orderSend: () => NEVER });

      const { state, outcome } = track(
        (
          service as unknown as {
            findOrders: (query: Row) => Promise<unknown>;
          }
        ).findOrders({
          post_id: '55',
          status: Order_status.ON_THE_ROAD,
          page: 1,
          limit: 10,
        }),
      );

      await jest.advanceTimersByTimeAsync(4999);
      expect(state.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const error = await outcome;

      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toEqual(
        expect.objectContaining({
          statusCode: 502,
          message: 'Order list request failed',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['bo‘sh satr', ''],
    ['faqat bo‘shliq', '   '],
    ['harflar', 'abc'],
    ['aralash', '12a'],
    ['manfiy', '-5'],
    ['kasr', '1.5'],
    ['undefined', undefined],
    ['null', null],
  ])(
    'noto‘g‘ri courier_id (%s) — 400, hech qanday so‘rov yo‘q',
    async (_label, courierId) => {
      const { service, postRepo, orderClient } = setup({
        posts: courierPosts,
      });

      await expectRpcError(
        service.openReturnPostsForCourier(courierId),
        400,
        INVALID_COURIER_MESSAGE,
      );
      expect(postRepo.find).not.toHaveBeenCalled();
      expect(orderClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'order-service RpcException (5xx)',
      () =>
        throwError(
          () => new RpcException({ statusCode: 500, message: 'db down' }),
        ),
    ],
    [
      'order-service RpcException (4xx)',
      () =>
        throwError(
          () => new RpcException({ statusCode: 400, message: 'bad query' }),
        ),
    ],
    ['xom xato', () => throwError(() => new Error('socket hang up'))],
    ['buzuq javob shakli', () => of({ data: 'oops' })],
  ])(
    'bitta pochtaning order.find_all xatosi (%s) — butun tekshiruv 503 RpcException',
    async (_label, failingReply) => {
      const { service } = setup({
        posts: courierPosts,
        orderSend: (pattern, payload) =>
          String(payload.query?.canceled_post_id) === '32'
            ? failingReply()
            : of({
                data: {
                  data:
                    ordersByPost[String(payload.query?.canceled_post_id)] ?? [],
                },
              }),
      });

      await expectRpcError(
        service.openReturnPostsForCourier('209'),
        503,
        UNAVAILABLE_MESSAGE,
      );
    },
  );

  it('pochta DB xatosi — 503 RpcException, order chaqiruvi yo‘q', async () => {
    const { service, orderClient } = setup({
      postFindError: new Error('connection terminated'),
    });

    await expectRpcError(
      service.openReturnPostsForCourier('209'),
      503,
      UNAVAILABLE_MESSAGE,
    );
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('rejected_for_courier o‘zgarmagan: u hamon guruh sonini beradi (kuryer ekrani uchun)', async () => {
    const { service, identityClient } = setup({ posts: courierPosts });

    const legacy = await service.rejectedPostsForCourier({
      id: '209',
      roles: ['courier'],
    });
    const lean = await service.openReturnPostsForCourier('209');

    // Bitta guruh: har bir pochta 2 + 0 + 1 = 3 ni oladi (bo'sh 32 ham).
    expect(
      (legacy.data as Row[]).map((post) => [post.id, post.order_quantity]),
    ).toEqual([
      ['31', 3],
      ['32', 3],
      ['33', 3],
    ]);
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.courier.find_by_ids' },
      { ids: ['209'] },
    );
    expect((lean.data as Row[]).map((post) => post.order_quantity)).toEqual([
      2, 0, 1,
    ]);
  });
});

describe('logistics.post.open_return_posts_for_courier handleri', () => {
  const handler = Object.getOwnPropertyDescriptor(
    LogisticsServiceController.prototype,
    'openReturnPostsForCourier',
  )?.value as (
    payload: { courier_id?: string } | undefined,
    context: RmqContext,
  ) => Promise<unknown>;

  const rmqContext = () =>
    ({
      getMessage: () => ({ fields: { redelivered: false } }),
      getPattern: () => CMD,
      getChannelRef: () => ({}),
    }) as unknown as RmqContext;

  function makeController(service: LogisticsServiceService) {
    const rmqService = new RmqService({} as ConfigService);
    const ack = jest.spyOn(rmqService, 'ack').mockImplementation(() => {});
    const nack = jest.spyOn(rmqService, 'nack').mockImplementation(() => {});
    const controller = new LogisticsServiceController(
      rmqService,
      service,
      {} as DistrictResolverService,
    );
    return { controller, ack, nack };
  }

  it(`naqsh AYNAN { cmd: '${CMD}' }`, () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: CMD },
    ]);
  });

  it('courier_id servisga uzatiladi va xabar ack qilinadi', async () => {
    const { service } = setup({ posts: courierPosts });
    const spy = jest.spyOn(service, 'openReturnPostsForCourier');
    const { controller, ack, nack } = makeController(service);
    const ctx = rmqContext();

    const result = await controller.openReturnPostsForCourier(
      { courier_id: '209' },
      ctx,
    );

    expect(spy).toHaveBeenCalledWith('209');
    expect(result.data).toHaveLength(3);
    expect(ack).toHaveBeenCalledWith(ctx);
    expect(nack).not.toHaveBeenCalled();
  });

  it.each([
    ['noto‘g‘ri courier_id', { courier_id: 'abc' }, 400, {}],
    ['payload yo‘q', undefined, 400, {}],
    [
      'order-service javob bermadi',
      { courier_id: '209' },
      503,
      {
        orderSend: () => throwError(() => new Error('socket hang up')),
      },
    ],
    [
      'DB xatosi',
      { courier_id: '209' },
      503,
      { postFindError: new Error('connection terminated') },
    ],
  ])(
    '%s — RpcException, xabar qayta navbatga QO‘YILMAYDI (DLQ)',
    async (_label, payload, statusCode, failure) => {
      const { service } = setup({ posts: courierPosts, ...failure });
      const { controller, ack, nack } = makeController(service);
      const ctx = rmqContext();

      await expectRpcError(
        controller.openReturnPostsForCourier(
          payload as { courier_id?: string },
          ctx,
        ),
        statusCode,
        statusCode === 400 ? INVALID_COURIER_MESSAGE : UNAVAILABLE_MESSAGE,
      );
      expect(ack).not.toHaveBeenCalled();
      expect(nack).toHaveBeenCalledWith(ctx, { requeue: false });
    },
  );
});
