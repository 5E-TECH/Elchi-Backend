import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NotificationServiceService } from './notification-service.service';

/**
 * (KJNHAlGW) Market o'z Telegram guruhlari holati: har doim ikkala tur,
 * group_id/bot_slug yo'q, market_id faqat tokendan.
 */
describe('KJNHAlGW — findMyTelegramGroups', () => {
  let repo: { find: jest.Mock };
  let identity: { send: jest.Mock };
  let service: NotificationServiceService;

  beforeEach(() => {
    repo = { find: jest.fn().mockResolvedValue([]) };
    identity = { send: jest.fn() };
    service = new NotificationServiceService(
      repo as never,
      identity as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('MARKET: market_id = sub; ulanmagan ikkala tur — linked=false, qolgani null', async () => {
    const res = await service.findMyTelegramGroups({
      requester: { id: '37', roles: ['market'] },
    });
    expect(repo.find.mock.calls[0][0].where).toEqual({
      market_id: '37',
      isDeleted: false,
    });
    expect(identity.send).not.toHaveBeenCalled();
    expect(res?.statusCode).toBe(200);
    expect(res?.data).toEqual([
      {
        group_type: 'create',
        linked: false,
        is_active: null,
        linked_at: null,
        inactive_reason: null,
      },
      {
        group_type: 'cancel',
        linked: false,
        is_active: null,
        linked_at: null,
        inactive_reason: null,
      },
    ]);
  });

  it('ulangan create (faol) + cancel (nofaol, kicked); group_id/bot_slug qaytmaydi', async () => {
    const createdAt = new Date('2026-10-20T10:00:00Z');
    const cancelAt = new Date('2026-10-21T10:00:00Z');
    repo.find.mockResolvedValue([
      {
        id: '11',
        createdAt: cancelAt,
        group_type: 'cancel',
        is_active: false,
        inactive_reason: 'kicked',
        group_id: '-100777',
        bot_slug: 'elchi',
      },
      {
        id: '10',
        createdAt,
        group_type: 'create',
        is_active: true,
        inactive_reason: null,
        group_id: '-100555',
      },
    ]);
    const res = await service.findMyTelegramGroups({
      requester: { id: '37', roles: ['market'] },
    });
    expect(repo.find.mock.calls[0][0].select).not.toHaveProperty('group_id');
    expect(repo.find.mock.calls[0][0].select).not.toHaveProperty('bot_slug');
    expect(res?.data).toEqual([
      {
        group_type: 'create',
        linked: true,
        is_active: true,
        linked_at: createdAt,
        inactive_reason: null,
      },
      {
        group_type: 'cancel',
        linked: true,
        is_active: false,
        linked_at: cancelAt,
        inactive_reason: 'kicked',
      },
    ]);
    expect(JSON.stringify(res?.data)).not.toContain('-100');
    expect(JSON.stringify(res?.data)).not.toContain('elchi');
  });

  it('MARKET_OPERATOR: market_id identity user.market_id dan', async () => {
    identity.send.mockReturnValue(of({ data: { market_id: '37' } }));
    await service.findMyTelegramGroups({
      requester: { id: '501', roles: ['market_operator'] },
    });
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      expect.objectContaining({ id: '501' }),
    );
    expect(repo.find.mock.calls[0][0].where.market_id).toBe('37');
  });

  it('biriktirilmagan operator → 403, bazaga so‘rov yo‘q', async () => {
    identity.send.mockReturnValue(of({ data: { market_id: null } }));
    await expect(
      service.findMyTelegramGroups({
        requester: { id: '501', roles: ['market_operator'] },
      }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('boshqa rol (admin) yoki requester yo‘q → 403', async () => {
    for (const requester of [{ id: '25', roles: ['admin'] }, undefined]) {
      await expect(
        service.findMyTelegramGroups({ requester }),
      ).rejects.toMatchObject({
        error: expect.objectContaining({ statusCode: 403 }),
      });
    }
    expect(repo.find).not.toHaveBeenCalled();
  });
});
