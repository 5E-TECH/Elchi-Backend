import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NotificationInboxService } from './notification-inbox.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: any[]) => rmqSendMock(...args),
  };
});

describe('NotificationInboxService', () => {
  let service: NotificationInboxService;
  let repo: any;
  let txRepo: any;
  let store: Map<string, any>;
  let identityClient: any;
  let gatewayClient: any;
  let telegramService: any;
  let activityLog: any;
  let pushDelivery: any;
  let smsDispatch: any;

  /** `In([...])` — FindOperator qiymati. */
  const valuesOf = (operator: any): string[] =>
    (operator?.value ?? operator ?? []).map(String);

  beforeEach(() => {
    rmqSendMock.mockReset();
    store = new Map();
    let nextId = 100;
    // Tranzaksiya ichidagi repo — xotiradagi jadvalga yozadi/o'qiydi.
    txRepo = {
      create: jest.fn((v) => ({ ...v })),
      insert: jest.fn((rows: any[]) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, { id, ...row });
            return { id };
          }),
        }),
      ),
      update: jest.fn((where: any, patch: any) => {
        for (const id of valuesOf(where.id)) {
          store.set(id, { ...store.get(id), ...patch });
        }
        return Promise.resolve({ affected: valuesOf(where.id).length });
      }),
      find: jest.fn(({ where }: any) => {
        const rows = [...store.values()];
        if (where.id) {
          const ids = valuesOf(where.id);
          return Promise.resolve(
            rows.filter((row) => ids.includes(String(row.id))),
          );
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
    };
    const manager = { getRepository: jest.fn(() => txRepo) };
    repo = {
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      save: jest.fn((e) => Promise.resolve({ id: '1', ...e })),
      create: jest.fn((v) => v),
      // recordDelivery: `UPDATE ... SET delivery = delivery || patch WHERE id IN (...)`.
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          update: jest.fn(() => qb),
          set: jest.fn(() => qb),
          setParameter: jest.fn(() => qb),
          whereInIds: jest.fn(() => qb),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return qb;
      }),
      manager: {
        transaction: jest.fn((work: (m: any) => Promise<unknown>) =>
          work(manager),
        ),
      },
    };
    identityClient = { send: jest.fn() };
    gatewayClient = { emit: jest.fn(() => of(null)) };
    telegramService = { sendNotification: jest.fn() };
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({
        items: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
      }),
      findByEntity: jest.fn().mockResolvedValue([]),
      findByUser: jest.fn().mockResolvedValue([]),
    };
    pushDelivery = { enqueue: jest.fn().mockResolvedValue(undefined) };
    smsDispatch = {
      assertFanout: jest.fn(),
      queueForNotifications: jest.fn().mockResolvedValue({
        sms: 0,
        sms_status: 'skipped',
        sms_reason: 'sms_disabled',
      }),
    };
    service = new NotificationInboxService(
      repo,
      identityClient,
      gatewayClient,
      telegramService,
      activityLog,
      pushDelivery,
      smsDispatch,
    );
  });

  it('dispatch persists a row for a single recipient and pushes realtime', async () => {
    const res = await service.dispatch({
      recipient_id: '42',
      type: 'order.sold',
      title: 'Sotildi',
    } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.dispatched).toBe(1);
    expect(txRepo.insert).toHaveBeenCalledTimes(1);
    expect(txRepo.insert.mock.calls[0][0]).toHaveLength(1);
    // realtime push fired to the recipient's room
    expect(gatewayClient.emit).toHaveBeenCalledWith(
      { cmd: 'realtime.notify' },
      expect.objectContaining({ event: 'notification:new', user_id: '42' }),
    );
    // push so'ralmagan — navbatga hech narsa qo'yilmaydi
    expect(pushDelivery.enqueue).not.toHaveBeenCalled();
  });

  it('dispatch throws 400 when no recipient is resolvable', async () => {
    await expect(
      service.dispatch({ type: 'order.sold', title: 'x' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('dispatch throws 400 when type/title missing', async () => {
    await expect(
      service.dispatch({ recipient_id: '42', title: 'x' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('dispatch dedupes by group_key (updates existing row)', async () => {
    store.set('7', {
      id: '7',
      recipient_id: '42',
      group_key: 'order-123',
      is_read: true,
      isDeleted: false,
    });

    const res = await service.dispatch({
      recipient_id: '42',
      type: 'order.accepted',
      title: 'Yangilandi',
      group_key: 'order-123',
    } as any);

    expect(res.data.dispatched).toBe(1);
    expect(txRepo.insert).not.toHaveBeenCalled();
    // existing row refreshed and unread reset
    expect(store.get('7')).toEqual(
      expect.objectContaining({
        id: '7',
        is_read: false,
        read_at: null,
        title: 'Yangilandi',
      }),
    );
  });

  it('dispatch resolves roles via identity and fans out', async () => {
    rmqSendMock.mockResolvedValueOnce({
      data: {
        items: [
          { id: '101', role: 'courier' },
          { id: '102', role: 'courier' },
        ],
        meta: { total: 2 },
      },
    });

    const res = await service.dispatch({
      roles: ['courier'],
      type: 'system.announcement',
      title: 'E’lon',
    } as any);

    expect(rmqSendMock).toHaveBeenCalledWith(
      identityClient,
      { cmd: 'identity.user.find_all' },
      expect.objectContaining({
        query: expect.objectContaining({ role: 'courier' }),
      }),
    );
    expect(res.data.dispatched).toBe(2);
    expect(txRepo.insert).toHaveBeenCalledTimes(1);
    expect(txRepo.insert.mock.calls[0][0]).toHaveLength(2);
  });

  it('persistRows is bulk: 40 recipients take far fewer than 40 DB queries (Jht84wGp #9)', async () => {
    const recipient_ids = Array.from({ length: 40 }, (_, i) => String(i + 1));

    const res = await service.dispatch({
      recipient_ids,
      type: 'system.announcement',
      title: 'E’lon',
      group_key: 'promo-1',
    } as any);

    const queries =
      txRepo.insert.mock.calls.length +
      txRepo.update.mock.calls.length +
      txRepo.find.mock.calls.length;
    expect(res.data.dispatched).toBe(40);
    expect(queries).toBeLessThan(40);
    expect(queries).toBeLessThanOrEqual(3); // group_key qidiruv + INSERT + qayta o'qish
  });

  it('push channel: rows start as delivery.push=queued and are enqueued in the SAME transaction', async () => {
    const res = await service.dispatch({
      recipient_ids: ['42', '43'],
      type: 'order.created',
      title: 'Yangi buyurtma',
      channels: ['in_app', 'push'],
    } as any);

    expect(res.data.dispatched).toBe(2);
    expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
    const inserted = txRepo.insert.mock.calls[0][0];
    inserted.forEach((row: any) =>
      expect(row.delivery).toEqual({ in_app: 'sent', push: 'queued' }),
    );
    const [manager, ids] = pushDelivery.enqueue.mock.calls[0];
    expect(manager.getRepository).toBeDefined();
    expect(ids).toEqual(
      res.data.recipient_ids.map((_: string, i: number) => String(100 + i)),
    );
    // realtime so'ralmagan — emit yo'q
    expect(gatewayClient.emit).not.toHaveBeenCalled();
  });

  it('a failing push enqueue fails the dispatch (rows roll back with it) and nothing is emitted', async () => {
    pushDelivery.enqueue.mockRejectedValueOnce(new Error('outbox down'));

    await expect(
      service.dispatch({
        recipient_id: '42',
        type: 'order.created',
        title: 'Yangi buyurtma',
        channels: ['in_app', 'realtime', 'push'],
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
    expect(gatewayClient.emit).not.toHaveBeenCalled();
  });

  it('SMS channel: queued in the same transaction and reported per channel (not a bare 201)', async () => {
    const res = await service.dispatch({
      recipient_ids: ['42', '43'],
      type: 'order.created',
      title: 'Yangi buyurtma',
      channels: ['in_app', 'sms'],
    } as any);

    expect(smsDispatch.assertFanout).toHaveBeenCalledWith(2);
    const [rows, manager] = smsDispatch.queueForNotifications.mock.calls[0];
    expect(rows).toHaveLength(2);
    expect(manager.getRepository).toBeDefined();
    expect(res.data.delivery).toEqual({
      in_app: 2,
      sms: 0,
      sms_status: 'skipped',
      sms_reason: 'sms_disabled',
    });
  });

  it('SMS fan-out over SMS_MAX_FANOUT fails the dispatch BEFORE anything is written', async () => {
    const { SmsBlockedError } = jest.requireActual('./sms/sms-gate.service');
    smsDispatch.assertFanout.mockImplementation(() => {
      throw new SmsBlockedError(
        'fanout_exceeded',
        'SMS qabul qiluvchilar soni 300 — chegara 200',
      );
    });

    await expect(
      service.dispatch({
        broadcast: false,
        recipient_ids: Array.from({ length: 300 }, (_, i) => String(i + 1)),
        type: 'marketing.promo',
        title: 'x',
        channels: ['sms'],
      } as any),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
    expect(txRepo.insert).not.toHaveBeenCalled();
  });

  it('list returns items, unread count and pagination meta', async () => {
    repo.findAndCount.mockResolvedValue([
      [
        {
          id: '1',
          recipient_id: '42',
          type: 'order.sold',
          title: 't',
          is_read: false,
          createdAt: new Date(),
        },
      ],
      1,
    ]);
    repo.count.mockResolvedValue(1);

    const res = await service.list({ recipient_id: '42' } as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.unread).toBe(1);
    expect(res.data.meta.total).toBe(1);
  });

  it('list throws 400 on invalid recipient_id', async () => {
    await expect(
      service.list({ recipient_id: 'abc' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('markAllRead reports how many were updated', async () => {
    repo.update.mockResolvedValue({ affected: 3 });

    const res = await service.markAllRead('42');

    expect(res.data.updated).toBe(3);
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_id: '42', is_read: false }),
      expect.objectContaining({ is_read: true }),
    );
  });

  it('markRead 404s when the notification is not owned by the user', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.markRead('42', '999')).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('unreadCount returns the count for the user', async () => {
    repo.count.mockResolvedValue(5);
    const res = await service.unreadCount('42');
    expect(res.data.unread).toBe(5);
  });
});
