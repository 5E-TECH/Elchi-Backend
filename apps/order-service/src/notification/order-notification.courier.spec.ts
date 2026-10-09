import { Logger } from '@nestjs/common';
import {
  Order_status,
  OutboxService,
  findNotificationType,
  isKnownNotificationType,
} from '@app/common';
import { OrderCustodyService } from '../custody/order-custody.service';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import {
  NOTIFICATION_DISPATCH_PATTERN,
  NOTIFICATION_OUTBOX_TARGET,
  ORDER_COURIER_ASSIGNED_TYPE,
  OrderNotificationService,
  buildCourierAssignedPayload,
} from './order-notification.service';

/**
 * ePpLHPX2 — `order.assigned_to_courier`: buyurtma kuryerga biriktirilganda
 * (logistics scan-assign / assign-to-courier → `order.update` → `updateFull`;
 * SA/ADMIN kuryer bilan `create`) biznes tranzaksiyasi ICHIDA outbox orqali
 * `notification.dispatch`. Nishon: kuryer + market. To'g'ridan-to'g'ri
 * rmqSend yo'q (order-notification.service.spec.ts TC5 statik tekshiradi).
 */

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const order = (overrides: Record<string, unknown> = {}) =>
  ({
    id: '81',
    market_id: '5',
    courier_id: '55',
    status: Order_status.ON_THE_ROAD,
    ...overrides,
  }) as any;

describe('buildCourierAssignedPayload', () => {
  it('nishon kuryer + market; link, group_key order:{id}:courier, category/priority katalogdan; PII yo‘q', () => {
    const entry = findNotificationType(ORDER_COURIER_ASSIGNED_TYPE)!;
    expect(isKnownNotificationType(ORDER_COURIER_ASSIGNED_TYPE)).toBe(true);
    expect(buildCourierAssignedPayload(order(), null)).toEqual({
      type: 'order.assigned_to_courier',
      category: entry.category,
      priority: entry.priority,
      title: entry.label_uz,
      body: 'Buyurtma #EL-100081 kuryerga biriktirildi.',
      data: {
        order_id: '81',
        order_number: 'EL-100081',
        courier_id: '55',
        previous_courier_id: null,
        status: Order_status.ON_THE_ROAD,
      },
      link: '/orders/81',
      recipient_ids: ['55', '5'],
      group_key: 'order:81:courier',
      channels: ['in_app', 'realtime'],
    });
    expect(entry.category).toBe('order');
  });

  it('kuryer almashdi (A → B) — yangi kuryerga; previous_courier_id yoziladi', () => {
    const payload = buildCourierAssignedPayload(
      order({ courier_id: '56' }),
      '55',
    )!;
    expect(payload.recipient_ids).toEqual(['56', '5']);
    expect(payload.data.previous_courier_id).toBe('55');
  });

  it.each([
    ['kuryer yo‘q', null, null],
    ['biriktirilmagan pochta ("0")', '0', null],
    ['kuryer o‘zgarmagan', '55', '55'],
    ['kuryer olib tashlandi', null, '55'],
  ])('%s — payload yo‘q', (_label, courierId, previous) => {
    expect(
      buildCourierAssignedPayload(order({ courier_id: courierId }), previous),
    ).toBeNull();
  });
});

/** Xotiradagi tranzaksiya: outbox qatorlari faqat commit'da "ko'rinadi". */
function makeTransaction() {
  const committed: any[] = [];
  let pending: any[] = [];
  const queryRunner: any = { isTransactionActive: true };
  const outboxRepo = {
    create: jest.fn((value: any) => ({ ...value })),
    save: jest.fn((value: any) => {
      pending.push(value);
      return Promise.resolve(value);
    }),
  };
  const manager: any = {
    queryRunner,
    getRepository: jest.fn(() => outboxRepo),
  };
  queryRunner.manager = manager;
  return {
    manager,
    outboxRepo,
    committed,
    commit: () => {
      committed.push(...pending);
      pending = [];
    },
    rollback: () => {
      pending = [];
    },
  };
}

describe('OrderNotificationService.onCourierAssigned — outbox, tranzaksiya ichida', () => {
  const notifier = () =>
    new OrderNotificationService(new OutboxService({} as never), {} as never);

  it('commit — outbox_events: target=NOTIFICATION, pattern=notification.dispatch, type=order.assigned_to_courier', async () => {
    const tx = makeTransaction();
    await notifier().onCourierAssigned(
      { order: order(), previous_courier_id: null },
      tx.manager,
    );
    tx.commit();
    expect(tx.committed).toEqual([
      expect.objectContaining({
        target: NOTIFICATION_OUTBOX_TARGET,
        pattern: NOTIFICATION_DISPATCH_PATTERN,
        status: 'pending',
        payload: expect.objectContaining({
          type: 'order.assigned_to_courier',
          recipient_ids: ['55', '5'],
          group_key: 'order:81:courier',
          request_id: expect.any(String),
        }),
      }),
    ]);
  });

  it('rollback — outbox qatori HAM yo‘q', async () => {
    const tx = makeTransaction();
    await notifier().onCourierAssigned(
      { order: order(), previous_courier_id: null },
      tx.manager,
    );
    tx.rollback();
    expect(tx.committed).toHaveLength(0);
  });

  it('tranzaksiya ichida DB xatosi — chaqiruvchiga (rollback qilsin); tranzaksiyasiz — yutiladi', async () => {
    const outbox = { enqueue: jest.fn().mockRejectedValue(new Error('db')) };
    const service = new OrderNotificationService(outbox as never, {} as never);
    const tx = makeTransaction();
    await expect(
      service.onCourierAssigned({ order: order() }, tx.manager),
    ).rejects.toThrow('db');
    await expect(
      service.onCourierAssigned({ order: order() }),
    ).resolves.toBeUndefined();
  });

  it('payload qurishda kutilmagan xato — biznes amali yiqilmaydi', async () => {
    const outbox = { enqueue: jest.fn() };
    const service = new OrderNotificationService(outbox as never, {} as never);
    const broken = {
      ...order(),
      get courier_id(): string {
        throw new Error('bug');
      },
    };
    await expect(
      service.onCourierAssigned({ order: broken }, makeTransaction().manager),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * Haqiqiy OrderLifecycleService + OrderCustodyService + OrderNotificationService;
 * DB — xotiradagi repolar, outbox — haqiqiy OutboxService (menejer orqali).
 */
function makeLifecycle(currentOrder: any) {
  const outboxRows: any[] = [];
  const outboxRepo = {
    create: jest.fn((value: any) => ({ ...value })),
    save: jest.fn((value: any) => {
      outboxRows.push(value);
      return Promise.resolve(value);
    }),
  };
  const state = { order: { ...currentOrder } };
  const orderRepo = {
    create: jest.fn((value: any) => ({ id: '81', ...value })),
    save: jest.fn((value: any) => {
      state.order = { ...state.order, ...value };
      return Promise.resolve(value);
    }),
    update: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(() => Promise.resolve({ ...state.order })),
  };
  const insertQb: any = {
    insert: jest.fn(() => insertQb),
    values: jest.fn(() => insertQb),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  const orderItemRepo = { createQueryBuilder: jest.fn(() => insertQb) };
  const trackingRepo: any = {
    create: jest.fn((value: any) => value),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const custodyRepo: any = {
    create: jest.fn((value: any) => value),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const queryRunner: any = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    isTransactionActive: true,
  };
  const manager: any = {
    queryRunner,
    getRepository: jest.fn((entity: { name: string }) => {
      switch (entity.name) {
        case 'Order':
          return orderRepo;
        case 'OrderItem':
          return orderItemRepo;
        case 'OutboxEvent':
          return outboxRepo;
        case 'OrderCustodyEvent':
          return custodyRepo;
        default:
          return trackingRepo;
      }
    }),
  };
  queryRunner.manager = manager;
  trackingRepo.manager = manager;
  custodyRepo.manager = manager;

  const notifier = new OrderNotificationService(
    new OutboxService({} as never),
    orderRepo as never,
  );
  const custody = new OrderCustodyService(trackingRepo, custodyRepo, notifier);
  const nullClient = { send: jest.fn() };
  const lifecycle = new OrderLifecycleService(
    { createQueryRunner: jest.fn(() => queryRunner) } as never,
    orderRepo as never,
    orderItemRepo as never,
    trackingRepo,
    custodyRepo,
    {} as never,
    {} as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    nullClient as never,
    nullClient as never,
    nullClient as never,
    nullClient as never,
    nullClient as never,
    nullClient as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    } as never,
    {
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    } as never,
    custody,
    notifier,
  );
  jest
    .spyOn<any, any>(lifecycle as any, 'syncOrderToSearch')
    .mockResolvedValue(undefined);
  jest
    .spyOn<any, any>(lifecycle as any, 'queueExternalStatusSync')
    .mockResolvedValue(undefined);
  jest
    .spyOn(lifecycle, 'findById')
    .mockImplementation(() =>
      Promise.resolve({ ...state.order, items: [] } as never),
    );
  const notifications = () =>
    outboxRows.filter((row) => row.target === NOTIFICATION_OUTBOX_TARGET);
  return { lifecycle, queryRunner, notifications };
}

const receivedOrder = () => ({
  id: '81',
  market_id: '5',
  customer_id: '2',
  operator_id: null,
  status: Order_status.RECEIVED,
  courier_id: null,
  branch_id: '3',
  holder_type: 'BRANCH',
  holder_branch_id: '3',
  holder_courier_id: null,
  total_price: 150000,
  region_id: null,
  district_id: null,
  address: null,
  comment: null,
  return_reason: null,
});

describe('updateFull — logistics scan-assign / assign-to-courier yo‘li (`order.update` dto.courier_id)', () => {
  it('kuryer + ON_THE_ROAD bitta tranzaksiyada: order.on_way (status guruhi) + order.assigned_to_courier (kuryer guruhi)', async () => {
    const { lifecycle, queryRunner, notifications } =
      makeLifecycle(receivedOrder());

    // logistics-service.scanAssignOrder → order.update payload'i aynan shu shaklda
    await lifecycle.updateFull(
      '81',
      {
        courier_id: '55',
        assigned_at: new Date().toISOString(),
        status: Order_status.ON_THE_ROAD,
        post_id: '900',
      },
      {
        id: '55',
        roles: ['courier'],
        note: 'Order skan orqali courierga biriktirildi',
      },
    );

    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    const rows = notifications();
    expect(rows.map((row) => row.payload.type)).toEqual([
      'order.on_way',
      'order.assigned_to_courier',
    ]);
    const courierRow = rows[1];
    expect(courierRow.pattern).toBe(NOTIFICATION_DISPATCH_PATTERN);
    expect(courierRow.payload).toEqual(
      expect.objectContaining({
        recipient_ids: ['55', '5'],
        group_key: 'order:81:courier',
        link: '/orders/81',
        category: 'order',
      }),
    );
    expect(rows[0].payload.group_key).toBe('order:81:status');
  });

  it('kuryer o‘zgarmagan (faqat post_id) — kuryer bildirishnomasi YO‘Q', async () => {
    const { lifecycle, notifications } = makeLifecycle({
      ...receivedOrder(),
      status: Order_status.ON_THE_ROAD,
      courier_id: '55',
      holder_type: 'COURIER',
      holder_courier_id: '55',
    });
    await lifecycle.updateFull(
      '81',
      { courier_id: '55', post_id: '901' },
      { id: '1', roles: ['admin'] },
    );
    expect(notifications()).toHaveLength(0);
  });

  it('kuryer almashdi (55 → 56) — yangi kuryerga bildirishnoma', async () => {
    const { lifecycle, notifications } = makeLifecycle({
      ...receivedOrder(),
      status: Order_status.ON_THE_ROAD,
      courier_id: '55',
      holder_type: 'COURIER',
      holder_courier_id: '55',
    });
    await lifecycle.updateFull(
      '81',
      { courier_id: '56' },
      { id: '1', roles: ['admin'] },
    );
    expect(notifications()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: 'order.assigned_to_courier',
          recipient_ids: ['56', '5'],
          data: expect.objectContaining({ previous_courier_id: '55' }),
        }),
      }),
    ]);
  });

  it('notifier ulanmagan (eski konstruktor) — updateFull avvalgidek ishlaydi', async () => {
    const { lifecycle } = makeLifecycle(receivedOrder());
    (lifecycle as any).orderNotifications = undefined;
    await expect(
      lifecycle.updateFull(
        '81',
        { courier_id: '55', status: Order_status.ON_THE_ROAD },
        { id: '55', roles: ['courier'] },
      ),
    ).resolves.toBeDefined();
  });
});

describe('create — SA/ADMIN kuryer bilan yaratgan buyurtma', () => {
  it('courier_id bilan — order.created + order.assigned_to_courier (shu tranzaksiyada)', async () => {
    const { lifecycle, queryRunner, notifications } = makeLifecycle({
      ...receivedOrder(),
      status: Order_status.NEW,
      courier_id: '55',
    });
    await lifecycle.create(
      { market_id: '5', customer_id: '2', courier_id: '55' },
      { id: '900', roles: ['admin'], branch_id: '3' } as never,
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(notifications().map((row) => row.payload.type)).toEqual([
      'order.created',
      'order.assigned_to_courier',
    ]);
  });

  it('kuryersiz yaratish — faqat order.created', async () => {
    const { lifecycle, notifications } = makeLifecycle({
      ...receivedOrder(),
      status: Order_status.NEW,
    });
    await lifecycle.create({ market_id: '5', customer_id: '2' }, {
      id: '900',
      roles: ['admin'],
      branch_id: '3',
    } as never);
    expect(notifications().map((row) => row.payload.type)).toEqual([
      'order.created',
    ]);
  });
});
