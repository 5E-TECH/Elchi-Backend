import { RpcException } from '@nestjs/microservices';
import { NotificationServiceService } from './notification-service.service';

/**
 * (qXlFQp8Q) PATCH (RMQ notification.telegram.update) — faqat is_active;
 * group_id / market_id / group_type kelsa 400, bazaga yozuv yo'q.
 */
describe('qXlFQp8Q — guruhni qo‘lda almashtirish yopiq (servis)', () => {
  let repo: Record<string, jest.Mock>;
  let service: NotificationServiceService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue({
        id: '10',
        market_id: '37',
        group_id: '-100555',
        group_type: 'create',
        is_active: true,
        inactive_reason: null,
        inactive_at: null,
      }),
      save: jest.fn((v) => Promise.resolve(v)),
    };
    service = new NotificationServiceService(
      repo as never,
      {} as never,
      { logChange: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
    );
  });

  it.each([
    { group_id: '-100999' },
    { market_id: '38' },
    { group_type: 'cancel' },
  ])('%j → 400, saqlanmaydi', async (extra) => {
    const error = await service
      .updateTelegramMarket({ id: '10', is_active: true, ...extra } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('faqat is_active — o‘tadi, group_id/market_id/group_type o‘zgarmaydi', async () => {
    const res = await service.updateTelegramMarket({
      id: '10',
      is_active: false,
    } as never);
    expect(res?.statusCode).toBe(200);
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: '37',
        group_id: '-100555',
        group_type: 'create',
        is_active: false,
      }),
    );
  });

  it('id yo‘q — 400 (market_id + group_type orqali qidirish ham yopiq)', async () => {
    await expect(
      service.updateTelegramMarket({ is_active: false } as never),
    ).rejects.toBeInstanceOf(RpcException);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
