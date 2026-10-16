import { RpcException } from '@nestjs/microservices';
import { NotificationServiceService } from './notification-service.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    Group_type: {
      ...(actual.Group_type ?? {}),
      CREATE: 'create',
      CANCEL: 'cancel',
    },
    ActivityAction: {
      ...(actual.ActivityAction ?? {}),
      CREATED: 'created',
      UPDATED: 'updated',
      DELETED: 'deleted',
    },
    ActivityLogService: class {},
    rmqSend: (...args: any[]) => rmqSendMock(...args),
  };
});

describe('NotificationServiceService', () => {
  let service: NotificationServiceService;
  let repo: any;
  let activityLog: any;
  let botOutbox: { send: jest.Mock };

  beforeEach(() => {
    rmqSendMock.mockReset();
    repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
    };
    // (bOMYoOtV) bot tokeni faqat env'dan — yuborish outbox orqali.
    botOutbox = {
      send: jest.fn().mockResolvedValue({ id: '1', status: 'sent' }),
    };
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
    service = new NotificationServiceService(
      repo,
      {} as any,
      activityLog,
      botOutbox as any,
      { claim: jest.fn().mockResolvedValue({ status: 'invalid' }) } as any,
    );
  });

  it('creates telegram market (success)', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockResolvedValue({ id: '1', market_id: '13' });

    const res = await service.createTelegramMarket({
      market_id: '13',
      group_id: '-1001',
      group_type: 'create' as any,
      is_active: true,
    } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('1');
  });

  it('throws 400 when duplicate market+group_type exists', async () => {
    repo.findOne.mockResolvedValue({ id: 'old' });

    await expect(
      service.createTelegramMarket({
        market_id: '13',
        group_id: '-1001',
        group_type: 'create' as any,
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('findAllTelegramMarkets throws when market_id is invalid', async () => {
    await expect(
      service.findAllTelegramMarkets({ market_id: 'abc' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('connectGroupByCodeText returns message on invalid link code', async () => {
    const res = await service.connectGroupByCodeText(
      'group_token-abc',
      '-10099',
    );
    expect(res).toHaveProperty('message');
    expect(String(res.message).toLowerCase()).toContain('kod');
  });

  it('sendNotification throws when message is empty', async () => {
    await expect(
      service.sendNotification({ message: '   ', group_id: '-1001' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('sendNotification sends direct to group via outbox (env bot)', async () => {
    const res = await service.sendNotification({
      message: 'hello',
      group_id: '-1001',
    } as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(1);
    expect(botOutbox.send).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '-1001', text: 'hello' }),
    );
  });

  it('sendNotification by market_id throws not found when no active group', async () => {
    repo.find.mockResolvedValue([]);

    await expect(
      service.sendNotification({
        message: 'hello',
        market_id: '13',
        group_type: 'create' as any,
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
