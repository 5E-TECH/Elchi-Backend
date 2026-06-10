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
  let identityClient: any;
  let gatewayClient: any;
  let telegramService: any;
  let activityLog: any;

  beforeEach(() => {
    rmqSendMock.mockReset();
    repo = {
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      save: jest.fn((e) => Promise.resolve({ id: '1', ...e })),
      create: jest.fn((v) => v),
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
    service = new NotificationInboxService(
      repo,
      identityClient,
      gatewayClient,
      telegramService,
      activityLog,
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
    expect(repo.save).toHaveBeenCalledTimes(1);
    // realtime push fired to the recipient's room
    expect(gatewayClient.emit).toHaveBeenCalledWith(
      { cmd: 'realtime.notify' },
      expect.objectContaining({ event: 'notification:new', user_id: '42' }),
    );
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
    repo.findOne.mockResolvedValue({ id: '7', recipient_id: '42', is_read: true });

    const res = await service.dispatch({
      recipient_id: '42',
      type: 'order.status',
      title: 'Yangilandi',
      group_key: 'order-123',
    } as any);

    expect(res.data.dispatched).toBe(1);
    expect(repo.create).not.toHaveBeenCalled();
    // existing row refreshed and unread reset
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '7', is_read: false, read_at: null }),
    );
  });

  it('dispatch resolves roles via identity and fans out', async () => {
    rmqSendMock.mockResolvedValueOnce({
      data: { items: [{ id: '101', role: 'courier' }, { id: '102', role: 'courier' }], meta: { total: 2 } },
    });

    const res = await service.dispatch({
      roles: ['courier'],
      type: 'system.broadcast',
      title: 'E’lon',
    } as any);

    expect(rmqSendMock).toHaveBeenCalledWith(
      identityClient,
      { cmd: 'identity.user.find_all' },
      expect.objectContaining({ query: expect.objectContaining({ role: 'courier' }) }),
    );
    expect(res.data.dispatched).toBe(2);
    expect(repo.save).toHaveBeenCalledTimes(2);
  });

  it('list returns items, unread count and pagination meta', async () => {
    repo.findAndCount.mockResolvedValue([
      [{ id: '1', recipient_id: '42', type: 'order.sold', title: 't', is_read: false, createdAt: new Date() }],
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
    await expect(service.list({ recipient_id: 'abc' } as any)).rejects.toBeInstanceOf(RpcException);
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
    await expect(service.markRead('42', '999')).rejects.toBeInstanceOf(RpcException);
  });

  it('unreadCount returns the count for the user', async () => {
    repo.count.mockResolvedValue(5);
    const res = await service.unreadCount('42');
    expect(res.data.unread).toBe(5);
  });
});
