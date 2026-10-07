import { RpcException } from '@nestjs/microservices';
import { PushSubscriptionService } from './push-subscription.service';

const validInput = {
  user_id: '42',
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'BNcR', auth: 'tBHI' },
  user_agent: 'Mozilla/5.0',
  platform: 'android',
  is_standalone: false,
};

const rpcError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('expected an RpcException');
};

describe('PushSubscriptionService', () => {
  let repo: any;
  let qb: any;
  let webPush: any;
  let service: PushSubscriptionService;

  beforeEach(() => {
    qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    repo = {
      createQueryBuilder: jest.fn(() => qb),
      findOneOrFail: jest.fn().mockResolvedValue({
        id: '5',
        platform: 'android',
        is_standalone: false,
      }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    webPush = { enabled: true, publicKey: 'BPUBLIC' };
    service = new PushSubscriptionService(repo, webPush);
  });

  it('public-key returns only the public key and the enabled flag', () => {
    expect(service.getPublicKey().data).toEqual({
      enabled: true,
      public_key: 'BPUBLIC',
    });
  });

  it('subscribe upserts by endpoint (same endpoint twice → same row, user_id refreshed)', async () => {
    const first = await service.subscribe(validInput);
    const second = await service.subscribe({ ...validInput, user_id: '77' });

    expect(first.data.id).toBe('5');
    expect(second.data.id).toBe('5');
    expect(qb.orUpdate).toHaveBeenCalledWith(
      expect.arrayContaining(['user_id', 'p256dh', 'auth', 'last_used_at']),
      ['endpoint'],
    );
    expect(qb.values).toHaveBeenLastCalledWith(
      expect.objectContaining({ user_id: '77', endpoint: validInput.endpoint }),
    );
  });

  it('cuts user_agent to 256 characters instead of failing', async () => {
    await service.subscribe({ ...validInput, user_agent: 'x'.repeat(600) });
    expect(qb.values.mock.calls[0][0].user_agent).toHaveLength(256);
  });

  it('falls back to desktop for an unknown platform', async () => {
    await service.subscribe({ ...validInput, platform: 'windows-phone' });
    expect(qb.values.mock.calls[0][0].platform).toBe('desktop');
  });

  it('rejects a non-https endpoint and missing keys with 400', async () => {
    expect(
      (
        await rpcError(
          service.subscribe({ ...validInput, endpoint: 'http://x' }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await rpcError(
          service.subscribe({ ...validInput, keys: { p256dh: '', auth: 'a' } }),
        )
      ).statusCode,
    ).toBe(400);
    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('answers 503 when web push is not configured on the server', async () => {
    webPush.enabled = false;
    expect((await rpcError(service.subscribe(validInput))).statusCode).toBe(
      503,
    );
  });

  it('unsubscribe deletes only the caller’s own endpoint', async () => {
    const res = await service.unsubscribe({
      user_id: '42',
      endpoint: validInput.endpoint,
    });
    expect(repo.delete).toHaveBeenCalledWith({
      user_id: '42',
      endpoint: validInput.endpoint,
    });
    expect(res.data).toEqual({ deleted: 1 });
  });

  it('another user’s (or an unknown) endpoint cannot be deleted → 404', async () => {
    repo.delete.mockResolvedValue({ affected: 0 });
    const error = await rpcError(
      service.unsubscribe({ user_id: '99', endpoint: validInput.endpoint }),
    );
    expect(error.statusCode).toBe(404);
  });
});
