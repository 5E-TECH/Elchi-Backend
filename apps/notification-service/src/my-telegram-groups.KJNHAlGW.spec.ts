import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NotificationServiceService } from './notification-service.service';

/**
 * (KJNHAlGW) Market o'z Telegram guruhlari holati: har doim ikkala tur,
 * group_id/bot_slug yo'q, market_id faqat tokendan.
 */
type FindArgs = {
  where: Record<string, unknown>;
  select: Record<string, unknown>;
};
const findArgs = (fn: jest.Mock) =>
  (fn.mock.calls as unknown[][])[0][0] as FindArgs;

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
    expect(findArgs(repo.find).where).toEqual({
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
        linked_by: null,
        linked_by_owner: null,
      },
      {
        group_type: 'cancel',
        linked: false,
        is_active: null,
        linked_at: null,
        inactive_reason: null,
        linked_by: null,
        linked_by_owner: null,
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
        linked_by: null,
        group_id: '-100777',
        bot_slug: 'elchi',
      },
      {
        id: '10',
        createdAt,
        group_type: 'create',
        is_active: true,
        inactive_reason: null,
        linked_by: null,
        group_id: '-100555',
      },
    ]);
    const res = await service.findMyTelegramGroups({
      requester: { id: '37', roles: ['market'] },
    });
    expect(findArgs(repo.find).select).not.toHaveProperty('group_id');
    expect(findArgs(repo.find).select).not.toHaveProperty('bot_slug');
    expect(res?.data).toEqual([
      {
        group_type: 'create',
        linked: true,
        is_active: true,
        linked_at: createdAt,
        inactive_reason: null,
        linked_by: null,
        linked_by_owner: null,
      },
      {
        group_type: 'cancel',
        linked: true,
        is_active: false,
        linked_at: cancelAt,
        inactive_reason: 'kicked',
        linked_by: null,
        linked_by_owner: null,
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
    expect(findArgs(repo.find).where.market_id).toBe('37');
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
      ).rejects.toMatchObject({ error: { statusCode: 403 } });
    }
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('⭐ BOT-2 #5: kim ulagan — ega (true), operator/admin (false), noma`lum (null)', async () => {
    repo.find.mockResolvedValue([
      {
        id: '11',
        createdAt: new Date(),
        group_type: 'cancel',
        is_active: true,
        inactive_reason: null,
        linked_by: '40',
      },
      {
        id: '10',
        createdAt: new Date(),
        group_type: 'create',
        is_active: true,
        inactive_reason: null,
        linked_by: '37',
      },
    ]);
    const res = await service.findMyTelegramGroups({
      requester: { id: '37', roles: ['market'] },
    });
    expect(findArgs(repo.find).select).toHaveProperty('linked_by', true);
    expect(
      (res?.data as Array<Record<string, unknown>>).map((row) => [
        row.group_type,
        row.linked_by,
        row.linked_by_owner,
      ]),
    ).toEqual([
      ['create', '37', true],
      ['cancel', '40', false],
    ]);
  });
});

describe('BOT-2 #5 — admin qo`lda yaratgan guruh (POST /notifications) linked_by', () => {
  it('⭐ createTelegramMarket — linked_by = admin id (egasi emas → linked_by_owner false)', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) =>
        Promise.resolve({ id: '10', ...row }),
      ),
    };
    const service = new NotificationServiceService(
      repo as never,
      {} as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
    );
    await service.createTelegramMarket({
      market_id: '37',
      group_id: '-100777',
      group_type: 'create',
      requester: { id: '1', roles: ['admin'] },
    } as never);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ market_id: '37', linked_by: '1' }),
    );
  });
});
