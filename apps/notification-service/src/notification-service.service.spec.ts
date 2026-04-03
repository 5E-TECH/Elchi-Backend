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
    rmqSend: (...args: any[]) => rmqSendMock(...args),
  };
});

describe('NotificationServiceService', () => {
  let service: NotificationServiceService;
  let repo: any;
  let config: any;

  beforeEach(() => {
    rmqSendMock.mockReset();
    repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
    };
    config = { get: jest.fn((k: string) => (k === 'TELEGRAM_BOT_TOKEN' ? 'ENV_TOKEN' : undefined)) };
    service = new NotificationServiceService(repo, config, {} as any);
    (global as any).fetch = jest.fn();
  });

  it('creates telegram market (success)', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockResolvedValue({ id: '1', market_id: '13' });

    const res = await service.createTelegramMarket({
      market_id: '13',
      group_id: '-1001',
      group_type: 'create' as any,
      token: 'x',
      is_active: true,
    } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('1');
  });

  it('throws 400 when duplicate market+group_type exists', async () => {
    repo.findOne.mockResolvedValue({ id: 'old' });

    await expect(
      service.createTelegramMarket({ market_id: '13', group_id: '-1001', group_type: 'create' as any } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('findAllTelegramMarkets throws when market_id is invalid', async () => {
    await expect(service.findAllTelegramMarkets({ market_id: 'abc' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('connectGroupByTokenText returns message on invalid token format', async () => {
    const res = await service.connectGroupByTokenText('group_token-abc', '-10099');
    expect(res).toHaveProperty('message');
    expect(String(res.message).toLowerCase()).toContain('token');
  });

  it('sendNotification throws when message is empty', async () => {
    await expect(service.sendNotification({ message: '   ', group_id: '-1001' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('sendNotification sends direct to group with env token', async () => {
    (global as any).fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });

    const res = await service.sendNotification({ message: 'hello', group_id: '-1001' } as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(1);
    expect((global as any).fetch).toHaveBeenCalled();
  });

  it('sendNotification by market_id throws not found when no active group', async () => {
    repo.find.mockResolvedValue([]);

    await expect(
      service.sendNotification({ message: 'hello', market_id: '13', group_type: 'create' as any } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
