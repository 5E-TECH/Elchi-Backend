import { Logger } from '@nestjs/common';
import { UserActivityService } from './user-activity.service';
import { AuthSessionService } from '../auth/auth-session.service';
import { IdentityController } from '../identity.controller';

/**
 * (pe71yf8L) `UserActivityService` va unga ulanishlar — bazasiz (CI).
 * Haqiqiy SQL: `user-activity.pe71yf8L.pg.spec.ts`.
 */
describe('pe71yf8L — UserActivityService (bazasiz)', () => {
  const makeService = (query = jest.fn().mockResolvedValue([])) => {
    const getMany = jest.fn().mockResolvedValue([
      {
        user_id: '26',
        last_login_at: new Date('2026-11-27T08:00:00.000Z'),
        last_seen_at: null,
      },
    ]);
    const qb = { where: jest.fn().mockReturnThis(), getMany };
    const repo = {
      query,
      createQueryBuilder: jest.fn(() => qb),
    };
    return {
      service: new UserActivityService(repo as never),
      query,
      qb,
      repo,
    };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('recordLogin — faqat raqamli id, ikkala ustun bitta vaqt bilan', async () => {
    const { service, query } = makeService();
    const at = new Date('2026-11-27T08:00:00.000Z');
    await service.recordLogin(26, at);
    await service.recordLogin('abc', at);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['26', at]);
    expect(String(query.mock.calls[0][0])).toContain('GREATEST');
  });

  it('yozish xatosi otilmaydi (login / refresh to`xtamaydi)', async () => {
    const { service } = makeService(
      jest.fn().mockRejectedValue(new Error('db down')),
    );
    await expect(service.recordLogin('26')).resolves.toBeUndefined();
    await expect(
      service.recordSeenBySession('sid', new Date()),
    ).resolves.toBeUndefined();
    await expect(
      service.recordSeen('26', new Date().toISOString()),
    ).resolves.toBe(false);
  });

  it('recordSeen — kelajak vaqt hozirga qisqaradi, 1 kundan eski / noto`g`ri — yozilmaydi', async () => {
    const { service, query } = makeService();
    const now = new Date('2026-11-27T10:00:00.000Z');
    await expect(
      service.recordSeen('26', '2026-11-27T11:00:00.000Z', now),
    ).resolves.toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['26', now]);
    await expect(
      service.recordSeen('26', '2026-11-25T10:00:00.000Z', now),
    ).resolves.toBe(false);
    await expect(service.recordSeen('26', 'x', now)).resolves.toBe(false);
    await expect(service.recordSeen({}, now.toISOString(), now)).resolves.toBe(
      false,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('findByUserIds — takrorsiz, faqat raqamli, ≤ 200; ISO javob', async () => {
    const { service, qb } = makeService();
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    const result = await service.findByUserIds([...ids, '1', 'x', null]);
    const passed = (qb.where.mock.calls[0][1] as { ids: string[] }).ids;
    expect(passed).toHaveLength(200);
    expect(new Set(passed).size).toBe(200);
    expect(result).toEqual([
      {
        user_id: '26',
        last_login_at: '2026-11-27T08:00:00.000Z',
        last_seen_at: null,
      },
    ]);
    const empty = makeService();
    await expect(empty.service.findByUserIds([])).resolves.toEqual([]);
    expect(empty.repo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('pe71yf8L — AuthSessionService ulanishi', () => {
  it('touch muvaffaqiyatli bo`lsa — recordSeenBySession; yopilgan sessiya — yo`q', async () => {
    const update = jest
      .fn()
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });
    const activity = {
      recordSeenBySession: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuthSessionService(
      { update } as never,
      undefined,
      activity as never,
    );
    const at = new Date('2026-11-27T09:00:00.000Z');
    await expect(service.touch('s-1', at)).resolves.toBe(true);
    await expect(service.touch('s-2', at)).resolves.toBe(false);
    expect(activity.recordSeenBySession).toHaveBeenCalledTimes(1);
    expect(activity.recordSeenBySession).toHaveBeenCalledWith('s-1', at);
  });

  it('open (qurilma ID siz) — sessiya ochilgach recordLogin', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const activity = { recordLogin: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthSessionService(
      { insert, create: (x: unknown) => x } as never,
      undefined,
      activity as never,
    );
    const now = new Date('2026-11-27T08:00:00.000Z');
    const row = await service.open({
      user: { id: '26', password: 'h', session_epoch: 0 } as never,
      refreshToken: 'r',
      method: 'password',
      expiresAt: new Date(now.getTime() + 3600_000),
      now,
    });
    expect(insert).toHaveBeenCalledWith(row);
    expect(activity.recordLogin).toHaveBeenCalledWith('26', now);
  });
});

describe('pe71yf8L — identity RMQ handlerlari', () => {
  const context = {
    getChannelRef: () => ({ ack: jest.fn() }),
    getMessage: () => ({}),
  };
  const rmq = { ack: jest.fn() };

  it('identity.user.activity.find_by_ids → { items }; servis yo`q → bo`sh', async () => {
    const activity = {
      findByUserIds: jest.fn().mockResolvedValue([{ user_id: '26' }]),
    };
    const controller = new IdentityController(
      rmq as never,
      {} as never,
      {} as never,
      {} as never,
      activity as never,
    );
    await expect(
      controller.findUserActivity({ user_ids: ['26'] }, context as never),
    ).resolves.toEqual({ items: [{ user_id: '26' }] });
    const bare = new IdentityController(
      rmq as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      bare.findUserActivity({ user_ids: ['26'] }, context as never),
    ).resolves.toEqual({ items: [] });
  });

  it('identity.user.activity.seen → { recorded }', async () => {
    const activity = { recordSeen: jest.fn().mockResolvedValue(true) };
    const controller = new IdentityController(
      rmq as never,
      {} as never,
      {} as never,
      {} as never,
      activity as never,
    );
    await expect(
      controller.recordUserSeen(
        { user_id: '26', at: '2026-11-27T09:00:00.000Z' },
        context as never,
      ),
    ).resolves.toEqual({ recorded: true });
    expect(activity.recordSeen).toHaveBeenCalledWith(
      '26',
      '2026-11-27T09:00:00.000Z',
    );
  });
});
