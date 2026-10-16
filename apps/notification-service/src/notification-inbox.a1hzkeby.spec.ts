import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationRetentionService } from './retention/notification-retention.service';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { NotificationInboxService } from './notification-inbox.service';
import { InboxPolicyService } from './retention/inbox-policy.service';
// Kontrakt: order-service HAQIQIY payload quruvchisi (outbox'ga aynan shu).
import { buildOrderNotificationPayload } from '../../order-service/src/notification/order-notification.service';

/**
 * A1HzKEby — inbox: group_key MAJBURIY (katalogdan / 400), bitta buyurtma =
 * bitta qator + data.count, soatlik bo'ron chegarasi, audit (bitta dispatch =
 * bitta haqiqiy-id'li qator), markAllRead bitta UPDATE, group_key NULL eski
 * qatorlar. Haqiqiy SQL (EXPLAIN, partiyali DELETE) —
 * notification-inbox.retention.pg.spec.ts.
 */

const policyWith = (env: Record<string, unknown>) =>
  new InboxPolicyService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

type Row = Record<string, any>;

const makeHarness = (policy?: InboxPolicyService) => {
  const store = new Map() as Map<string, Row>;
  let nextId = 1;
  let clock = Date.parse('2026-10-16T09:00:00.000Z');
  const tick = () => new Date((clock += 1000));
  const valuesOf = (operator: any): string[] =>
    (operator?.value ?? operator ?? []).map(String);
  const capQueries: Array<{ ids: string[]; type: string }> = [];

  /** Soatlik chegara so'rovi (DISTINCT ON + COUNT OVER) taqlidi. */
  const capQb = () => {
    const params: Record<string, any> = {};
    const qb: any = {};
    for (const m of ['select', 'addSelect', 'distinctOn', 'orderBy']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.addOrderBy = jest.fn(() => qb);
    qb.where = jest.fn((_sql: string, p?: Record<string, any>) => {
      Object.assign(params, p ?? {});
      return qb;
    });
    qb.andWhere = qb.where;
    qb.getRawMany = jest.fn(() => {
      const ids = (params.ids as string[]).map(String);
      capQueries.push({ ids, type: params.type });
      const out: Row[] = [];
      for (const id of ids) {
        const mine = [...store.values()]
          .filter(
            (row) =>
              String(row.recipient_id) === id &&
              row.type === params.type &&
              !row.isDeleted,
          )
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              Number(b.id) - Number(a.id),
          );
        if (mine.length) {
          out.push({
            recipient_id: id,
            id: mine[0].id,
            count:
              mine[0].data?.count === undefined
                ? null
                : String(mine[0].data.count),
            recent: String(mine.length),
          });
        }
      }
      return Promise.resolve(out);
    });
    return qb;
  };

  const txRepo = {
    create: jest.fn((value: Row) => ({ ...value })),
    insert: jest.fn((rows: Row[]) =>
      Promise.resolve({
        identifiers: rows.map((row) => {
          const id = String(nextId++);
          store.set(id, { id, isDeleted: false, ...row, createdAt: tick() });
          return { id };
        }),
      }),
    ),
    update: jest.fn((where: any, patch: Row) => {
      const ids = valuesOf(where.id);
      for (const id of ids) {
        const next = { ...store.get(id), ...patch };
        if (typeof patch.createdAt === 'function') next.createdAt = tick();
        store.set(id, next);
      }
      return Promise.resolve({ affected: ids.length });
    }),
    find: jest.fn(({ where }: any) => {
      const rows = [...store.values()];
      if (where.id) {
        const ids = valuesOf(where.id);
        return Promise.resolve(rows.filter((row) => ids.includes(row.id)));
      }
      const recipients = valuesOf(where.recipient_id);
      return Promise.resolve(
        rows.filter(
          (row) =>
            recipients.includes(String(row.recipient_id)) &&
            row.group_key === where.group_key &&
            !row.isDeleted,
        ),
      );
    }),
    createQueryBuilder: jest.fn(() => capQb()),
  };
  const ownRows = (where: any) =>
    [...store.values()].filter(
      (row) =>
        String(row.recipient_id) === String(where.recipient_id) &&
        !row.isDeleted &&
        (where.is_read === undefined || row.is_read === where.is_read) &&
        (where.category === undefined || row.category === where.category) &&
        (where.type === undefined || row.type === where.type),
    );
  const deliveryQb: any = {};
  for (const m of ['update', 'set', 'setParameter', 'whereInIds']) {
    deliveryQb[m] = jest.fn(() => deliveryQb);
  }
  deliveryQb.execute = jest.fn().mockResolvedValue({ affected: 0 });
  const repo: any = {
    findAndCount: jest.fn(({ where }: any) => {
      const rows = ownRows(where);
      return Promise.resolve([rows, rows.length]);
    }),
    count: jest.fn(({ where }: any) => Promise.resolve(ownRows(where).length)),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 7 }),
    createQueryBuilder: jest.fn(() => deliveryQb),
    manager: {
      transaction: jest.fn((work: (manager: any) => Promise<unknown>) =>
        work({ getRepository: () => txRepo }),
      ),
    },
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new NotificationInboxService(
    repo,
    { send: jest.fn() } as any,
    { emit: jest.fn(() => of(null)) } as any,
    { sendNotification: jest.fn() } as any,
    activityLog as any,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as any,
    { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    policy,
  );
  return { service, store, repo, txRepo, activityLog, capQueries };
};

const errorOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: unknown) =>
      (err as RpcException).getError() as {
        statusCode: number;
        message: string;
      },
  );

const order = (status: Order_status) =>
  ({
    id: '81',
    market_id: '5',
    operator_id: '9',
    status,
    total_price: 150000,
    address: 'Chilonzor',
    comment: null,
    return_reason: null,
  }) as any;

/** order-service outbox qatori (+ OutboxService qo'shadigan request_id). */
const orderEvent = (
  type: Parameters<typeof buildOrderNotificationPayload>[0],
  status: Order_status,
  from: Order_status | null,
) => ({
  ...buildOrderNotificationPayload(type, order(status), from, {
    logist_id: '77',
  })!,
  request_id: 'req-' + type,
});

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('A1HzKEby #1 — group_key MAJBURIY: DTO → katalog → 400', () => {
  it('DTOda berilmasa katalog shablonidan hosil bo‘ladi (order.sold + data.order_id → order:81:status)', async () => {
    const h = makeHarness();
    await h.service.dispatch({
      recipient_id: '42',
      type: 'order.sold',
      title: 'Sotildi',
      data: { order_id: 81 },
    } as any);
    expect([...h.store.values()].map((row) => row.group_key)).toEqual([
      'order:81:status',
    ]);
  });

  it('shablonli turda data o‘zgaruvchisi yo‘q → 400, xabarda shablon va yetishmagan maydon; hech narsa yozilmaydi', async () => {
    const h = makeHarness();
    const err = await errorOf(
      h.service.dispatch({
        recipient_id: '42',
        type: 'finance.payment_received',
        title: 'To‘lov',
        data: { amount: 1000 },
      } as any),
    );
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toContain('finance:payment:');
    expect(err?.message).toContain('data.payment_id');
    expect(h.txRepo.insert).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
  });

  it('DTO group_key — ustun (katalog shablonidan emas)', async () => {
    const h = makeHarness();
    await h.service.dispatch({
      recipient_id: '42',
      type: 'order.sold',
      title: 'Sotildi',
      group_key: 'custom:1',
    } as any);
    expect([...h.store.values()][0].group_key).toBe('custom:1');
  });

  it('shablonsiz tur (system.manual): group_key = type:dispatch_id — ikki dispatch ikki qator, ayni request_id qayta kelsa yangi qator YO‘Q', async () => {
    const h = makeHarness();
    const first: any = await h.service.dispatch({
      recipient_id: '42',
      type: 'system.manual',
      title: 'Birinchi',
      request_id: 'req-a',
    } as any);
    await h.service.dispatch({
      recipient_id: '42',
      type: 'system.manual',
      title: 'Ikkinchi',
      request_id: 'req-b',
    } as any);
    const keys = [...h.store.values()].map((row) => row.group_key);
    expect(keys).toEqual(['system.manual:req-a', 'system.manual:req-b']);
    expect(first.data.dispatch_id).toBe('req-a');
    // Ayni partiya qayta yetkazildi (RMQ qayta urinishi) — qator ko'paymaydi.
    await h.service.dispatch({
      recipient_id: '42',
      type: 'system.manual',
      title: 'Birinchi',
      request_id: 'req-a',
    } as any);
    expect(h.store.size).toBe(2);
    expect([...h.store.values()].every((row) => row.group_key)).toBe(true);
  });
});

describe('A1HzKEby #1/#4 — bitta buyurtma 5 status → inboxda 1 qator, data.count = 5', () => {
  const chain = () => [
    orderEvent('order.created', Order_status.NEW, null),
    orderEvent('order.accepted', Order_status.RECEIVED, Order_status.NEW),
    orderEvent('order.on_way', Order_status.ON_THE_ROAD, Order_status.RECEIVED),
    orderEvent(
      'order.not_accepted',
      Order_status.WAITING_CUSTOMER,
      Order_status.ON_THE_ROAD,
    ),
    orderEvent('order.sold', Order_status.SOLD, Order_status.WAITING_CUSTOMER),
  ];

  it('market / operator / logist — har birida BITTA qator, oxirgi holat, count 5', async () => {
    const h = makeHarness(policyWith({}));
    for (const event of chain()) {
      expect(event.group_key).toBe('order:81:status');
      await h.service.dispatch(event as any);
    }
    const rows = [...h.store.values()];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.recipient_id).sort()).toEqual([
      '5',
      '77',
      '9',
    ]);
    for (const row of rows) {
      expect(row.type).toBe('order.sold');
      expect(row.group_key).toBe('order:81:status');
      expect(row.data).toEqual(
        expect.objectContaining({ order_id: '81', count: 5 }),
      );
      expect(row.is_read).toBe(false);
    }
    const inbox: any = await h.service.list({ recipient_id: '5' } as any);
    expect(inbox.data.items).toHaveLength(1);
    expect(inbox.data.items[0].data.count).toBe(5);
  });

  it('o‘qilgan qator yangi hodisada qayta o‘qilmagan bo‘ladi va count oshadi', async () => {
    const h = makeHarness();
    const [created, accepted] = chain();
    await h.service.dispatch(created as any);
    for (const row of h.store.values()) row.is_read = true;
    await h.service.dispatch(accepted as any);
    for (const row of h.store.values()) {
      expect(row.is_read).toBe(false);
      expect(row.data.count).toBe(2);
    }
  });
});

describe('A1HzKEby #4 — soatlik bo‘ron chegarasi (NOTIF_HOURLY_CAP_PER_TYPE)', () => {
  const send = (h: ReturnType<typeof makeHarness>, n: number, extra = {}) =>
    h.service.dispatch({
      recipient_id: '42',
      type: 'system.manual',
      title: 'Xabar ' + n,
      data: { n },
      request_id: 'req-' + n,
      ...extra,
    } as any);

  it('chegaradan oshgan takroriy xabar yangi qator yaratmaydi — oxirgi qator yangilanadi, data.count oshadi', async () => {
    const h = makeHarness(policyWith({ NOTIF_HOURLY_CAP_PER_TYPE: '3' }));
    for (let n = 1; n <= 5; n += 1) await send(h, n);
    const rows = [...h.store.values()];
    expect(rows).toHaveLength(3);
    const latest = rows.find((row) => row.title === 'Xabar 5')!;
    expect(latest.data).toEqual({ n: 5, count: 3 });
    expect(latest.is_read).toBe(false);
    expect(latest.group_key).toBe('system.manual:req-5');
    // Chegara so'rovi — shu tur bo'yicha, recipient_id IN (...).
    expect(h.capQueries[h.capQueries.length - 1]).toEqual({
      ids: ['42'],
      type: 'system.manual',
    });
  });

  it('chegara qabul qiluvchi bo‘yicha: boshqa foydalanuvchiga yangi qator yoziladi', async () => {
    const h = makeHarness(policyWith({ NOTIF_HOURLY_CAP_PER_TYPE: 2 }));
    await send(h, 1);
    await send(h, 2);
    await send(h, 3, { recipient_id: undefined, recipient_ids: ['42', '43'] });
    const mine = [...h.store.values()].filter((r) => r.recipient_id === '42');
    const other = [...h.store.values()].filter((r) => r.recipient_id === '43');
    expect(mine).toHaveLength(2);
    expect(other).toHaveLength(1);
    expect(other[0].data).toEqual({ n: 3 });
  });

  it('priority=critical — chegarasiz (har hodisa alohida qator, so‘rov ham yo‘q)', async () => {
    const h = makeHarness(policyWith({ NOTIF_HOURLY_CAP_PER_TYPE: 2 }));
    for (let n = 1; n <= 4; n += 1) {
      await send(h, n, { type: 'account.password_changed' });
    }
    expect(h.store.size).toBe(4);
    expect(h.capQueries).toHaveLength(0);
  });

  it('NOTIF_HOURLY_CAP_PER_TYPE=0 — chegara o‘chiq', async () => {
    const h = makeHarness(policyWith({ NOTIF_HOURLY_CAP_PER_TYPE: '0' }));
    for (let n = 1; n <= 4; n += 1) await send(h, n);
    expect(h.store.size).toBe(4);
    expect(h.capQueries).toHaveLength(0);
  });
});

describe('A1HzKEby #5 / #2 / #13 — audit, markAllRead, group_key NULL eski qatorlar', () => {
  it('bitta dispatch (3 qabul qiluvchi) = BITTA audit qatori; entity_id — haqiqiy dispatch_id, "dispatch" emas', async () => {
    const h = makeHarness();
    const res: any = await h.service.dispatch({
      recipient_ids: ['1', '2', '3'],
      type: 'system.manual',
      title: 'E‘lon',
    } as any);
    expect(h.activityLog.log).toHaveBeenCalledTimes(1);
    const entry = h.activityLog.log.mock.calls[0][0];
    expect(entry.action).toBe('notification.dispatched');
    expect(entry.entity_id).not.toBe('dispatch');
    expect(entry.entity_id).toBe(res.data.dispatch_id);
    expect(entry.entity_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.metadata.dispatched_count).toBe(3);
  });

  it('markAllRead — BITTA UPDATE (sikl, find/save yo‘q)', async () => {
    const h = makeHarness();
    const res: any = await h.service.markAllRead('42');
    expect(h.repo.update).toHaveBeenCalledTimes(1);
    expect(h.repo.update.mock.calls[0][0]).toEqual({
      recipient_id: '42',
      isDeleted: false,
      is_read: false,
    });
    expect(h.repo.find).not.toHaveBeenCalled();
    expect(h.repo.save).not.toHaveBeenCalled();
    expect(res.data.updated).toBe(7);
  });

  it('group_key NULL eski qator ro‘yxat va filtrlarda ko‘rinadi; yangi dispatch unga tegmaydi', async () => {
    const h = makeHarness();
    h.store.set('900', {
      id: '900',
      recipient_id: '42',
      type: 'order.sold',
      category: 'order',
      title: 'Eski',
      data: null,
      group_key: null,
      is_read: false,
      isDeleted: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await h.service.dispatch({
      recipient_id: '42',
      type: 'order.sold',
      title: 'Yangi',
      data: { order_id: 81 },
    } as any);
    expect(h.store.get('900')!.title).toBe('Eski');
    const all: any = await h.service.list({ recipient_id: '42' } as any);
    expect(all.data.items.map((i: any) => i.title).sort()).toEqual([
      'Eski',
      'Yangi',
    ]);
    const filtered: any = await h.service.list({
      recipient_id: '42',
      is_read: false,
      category: 'order',
      type: 'order.sold',
    } as any);
    expect(filtered.data.meta.total).toBe(2);
    expect(
      filtered.data.items.find((i: any) => i.id === '900').data,
    ).toBeNull();
  });
});

describe('A1HzKEby #3 — retention muddatlari .env dan, cron', () => {
  it('sukutlar: retention O‘CHIQ, o‘qilgan 60 / o‘qilmagan 180 kun, partiya 5000, kunlik cron; chegara 30', () => {
    expect(policyWith({}).retention).toEqual({
      enabled: false,
      dryRun: false,
      readDays: 60,
      unreadDays: 180,
      batchSize: 5000,
      maxBatches: 200,
      cron: '0 30 3 * * *',
      invalid: null,
    });
    expect(policyWith({}).hourlyCapPerType).toBe(30);
  });

  it('muddatlar va partiya .env dan o‘qiladi (kodga yozilmagan)', () => {
    const r = policyWith({
      NOTIF_RETENTION_ENABLED: 'true',
      NOTIF_RETENTION_DRY_RUN: true,
      NOTIF_RETENTION_READ_DAYS: '30',
      NOTIF_RETENTION_UNREAD_DAYS: 90,
      NOTIF_RETENTION_BATCH_SIZE: '1000',
      NOTIF_RETENTION_MAX_BATCHES: '5',
      NOTIF_RETENTION_CRON_EXPR: '0 0 4 * * *',
    }).retention;
    expect(r).toEqual({
      enabled: true,
      dryRun: true,
      readDays: 30,
      unreadDays: 90,
      batchSize: 1000,
      maxBatches: 5,
      cron: '0 0 4 * * *',
      invalid: null,
    });
  });

  it('o‘qilmaganlar muddati o‘qilganlarnikidan UZUN bo‘lishi shart — aks holda retention ishlamaydi', () => {
    const same = policyWith({
      NOTIF_RETENTION_READ_DAYS: 90,
      NOTIF_RETENTION_UNREAD_DAYS: 90,
    }).retention;
    expect(same.invalid).toContain('UZUN');
    expect(
      policyWith({ NOTIF_RETENTION_READ_DAYS: 3 }).retention.invalid,
    ).toContain('NOTIF_RETENTION_READ_DAYS');
    expect(
      policyWith({ NOTIF_RETENTION_UNREAD_DAYS: 'abc' }).retention.invalid,
    ).not.toBeNull();
  });

  it('cron: sukut bo‘yicha ro‘yxatga OLINMAYDI; yoqilsa — kunlik job; noto‘g‘ri sozlama — job yo‘q', async () => {
    const make = (env: Record<string, unknown>) => {
      const scheduler = { addCronJob: jest.fn() };
      const svc = new NotificationRetentionService(
        policyWith(env),
        {} as any,
        scheduler as any,
        {} as any,
      );
      svc.onModuleInit();
      return { svc, scheduler };
    };
    const off = make({});
    expect(off.scheduler.addCronJob).not.toHaveBeenCalled();

    const bad = make({
      NOTIF_RETENTION_ENABLED: 'true',
      NOTIF_RETENTION_READ_DAYS: 90,
      NOTIF_RETENTION_UNREAD_DAYS: 30,
    });
    expect(bad.scheduler.addCronJob).not.toHaveBeenCalled();

    const on = make({ NOTIF_RETENTION_ENABLED: 'true' });
    expect(on.scheduler.addCronJob).toHaveBeenCalledWith(
      'notification.inbox.retention',
      expect.anything(),
    );
    await on.svc.onModuleDestroy();
  });
});

describe('A1HzKEby — ScheduleModule va servis ko‘tarilishi', () => {
  it('notification-service.module: ScheduleModule.forRoot() + retention/policy/directory providerlari', () => {
    const src = readFileSync(
      join(__dirname, 'notification-service.module.ts'),
      'utf8',
    );
    expect(src).toMatch(/ScheduleModule\.forRoot\(\)/);
    for (const name of [
      'InboxPolicyService',
      'NotificationRetentionService',
      'RecipientDirectoryService',
    ]) {
      expect(src).toMatch(new RegExp('providers:[\\s\\S]*\\b' + name + ','));
    }
  });

  it('Nest: ScheduleModule bilan retention cron ro‘yxatga olinadi va modul yopilganda to‘xtaydi', async () => {
    const env: Record<string, unknown> = { NOTIF_RETENTION_ENABLED: 'true' };
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        NotificationRetentionService,
        InboxPolicyService,
        { provide: getRepositoryToken(Notification), useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    await moduleRef.init();
    const job = moduleRef
      .get(SchedulerRegistry)
      .getCronJob('notification.inbox.retention');
    expect(job).toBeDefined();
    expect(job.isActive).toBe(true);
    await moduleRef.close();
    expect(job.isActive).toBe(false);
  });
});
