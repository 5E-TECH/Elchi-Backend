import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { RpcException } from '@nestjs/microservices';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { IdentityController } from './identity.controller';

/**
 * rCFZAmOz + td89SKXQ / 9uNhwTZp — `users.telegram_id` HAQIQATAN to'ldiriladi
 * (bot `/start <bir martalik kod>` → `identity.telegram.link`), BeePost
 * tekshiruvlari bilan: band id → 409, boshqa id bilan ulangan → 409, faol
 * emas → 403, mijoz/investor → 403. notification-service `contacts_by_ids`
 * orqali o'qiydi.
 */
type Row = Record<string, unknown>;

describe('identity — Telegram ulash (rCFZAmOz / td89SKXQ)', () => {
  function make(
    affected = 1,
    rows: Row[] = [],
    options: { user?: Row | null; owner?: Row | null } = {},
  ) {
    const users = {
      update: jest.fn().mockResolvedValue({ affected }),
      find: jest.fn().mockResolvedValue(rows),
      findOne: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          'telegram_id' in where
            ? (options.owner ?? null)
            : options.user === undefined
              ? {
                  id: '7',
                  role: Roles.COURIER,
                  status: Status.ACTIVE,
                  telegram_id: null,
                }
              : options.user,
        ),
      ),
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = Object.create(
      UserServiceService.prototype,
    ) as UserServiceService;
    Object.assign(svc, { users, activityLog });
    return Object.assign(svc, {
      usersMock: users,
      activityLogMock: activityLog,
    });
  }

  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => (error as RpcException).getError() as Row,
    );

  it('⭐ telegramLink — faol kuryerga telegram_id + username + linked_at yoziladi, audit', async () => {
    const svc = make();
    const res = await svc.telegramLink({
      user_id: '7',
      telegram_id: 5550007,
      telegram_username: '@ali',
    });
    expect(svc.usersMock.update).toHaveBeenCalledWith(
      { id: '7', isDeleted: false, status: Status.ACTIVE },
      expect.objectContaining({
        telegram_id: '5550007',
        telegram_username: 'ali',
        telegram_linked_at: expect.any(Date),
      }),
    );
    expect(res).toMatchObject({ data: { linked: true, user_id: '7' } });
    expect(svc.activityLogMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.tg_linked',
        entity_id: '7',
      }),
    );
  });

  it('⭐ band telegram_id ni ikkinchi xodimga bog‘lash → 409, UPDATE yo‘q', async () => {
    const svc = make(1, [], { owner: { id: '8', isDeleted: false } });
    expect(
      await errorOf(svc.telegramLink({ user_id: '7', telegram_id: '5550007' })),
    ).toEqual(expect.objectContaining({ statusCode: 409 }));
    expect(svc.usersMock.update).not.toHaveBeenCalled();
  });

  it('⭐ boshqa telegram_id ga ega xodimni qayta bog‘lash → 409', async () => {
    const svc = make(1, [], {
      user: {
        id: '7',
        role: Roles.COURIER,
        status: Status.ACTIVE,
        telegram_id: '111',
      },
    });
    expect(
      await errorOf(svc.telegramLink({ user_id: '7', telegram_id: '5550007' })),
    ).toEqual(expect.objectContaining({ statusCode: 409 }));
    expect(svc.usersMock.update).not.toHaveBeenCalled();
  });

  it.each([
    ['status != ACTIVE', { status: Status.INACTIVE, role: Roles.COURIER }],
    ['mijoz', { status: Status.ACTIVE, role: Roles.CUSTOMER }],
    ['investor', { status: Status.ACTIVE, role: Roles.INVESTOR }],
  ])('⭐ %s — rad (403)', async (_label, patch) => {
    const svc = make(1, [], { user: { id: '7', telegram_id: null, ...patch } });
    expect(
      await errorOf(svc.telegramLink({ user_id: '7', telegram_id: '5550007' })),
    ).toEqual(expect.objectContaining({ statusCode: 403 }));
    expect(svc.usersMock.update).not.toHaveBeenCalled();
  });

  it('o‘chirilgan akkauntda qolgan bog‘lanish bo‘shatiladi, keyin ulanadi', async () => {
    const svc = make(1, [], { owner: { id: '3', isDeleted: true } });
    await svc.telegramLink({ user_id: '7', telegram_id: '5550007' });
    expect(svc.usersMock.update).toHaveBeenNthCalledWith(
      1,
      { id: '3' },
      { telegram_id: null, telegram_username: null, telegram_linked_at: null },
    );
    expect(svc.usersMock.update).toHaveBeenCalledTimes(2);
  });

  it('poyga: unique indeks (23505) → 409', async () => {
    const svc = make();
    svc.usersMock.update.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: '23505' }),
    );
    expect(
      await errorOf(svc.telegramLink({ user_id: '7', telegram_id: '5550007' })),
    ).toEqual(expect.objectContaining({ statusCode: 409 }));
  });

  it('telegramBind (eski nom) — telegramLink tekshiruvlari bilan; noto‘g‘ri id 400, topilmasa 404', async () => {
    const svc = make();
    const res = await svc.telegramBind({ user_id: '7', telegram_id: 5550007 });
    expect(res).toMatchObject({ data: { bound: true } });
    for (const payload of [
      { user_id: 'abc', telegram_id: '1' },
      { user_id: '7', telegram_id: 'x; DROP' },
      { user_id: '7' },
    ]) {
      await expect(svc.telegramBind(payload)).rejects.toBeInstanceOf(
        RpcException,
      );
    }
    expect(
      await errorOf(
        make(1, [], { user: null }).telegramBind({
          user_id: '7',
          telegram_id: '1',
        }),
      ),
    ).toEqual(expect.objectContaining({ statusCode: 404 }));
  });

  it('telegramUnbind — shu chat ulangan akkauntlardan uziladi (username, linked_at ham)', async () => {
    const svc = make(2);
    const res = await svc.telegramUnbind({ telegram_id: '5550007' });
    expect(svc.usersMock.update).toHaveBeenCalledWith(
      { telegram_id: '5550007' },
      { telegram_id: null, telegram_username: null, telegram_linked_at: null },
    );
    expect(res).toMatchObject({ data: { unbound: 2 } });
  });

  it('⭐ DELETE /users/me/telegram (telegramUnlinkUser) — telegram_id null, audit yoziladi', async () => {
    const svc = make(1);
    const res = await svc.telegramUnlinkUser({ user_id: '7' });
    expect(svc.usersMock.update).toHaveBeenCalledWith(
      { id: '7' },
      { telegram_id: null, telegram_username: null, telegram_linked_at: null },
    );
    expect(res).toMatchObject({ data: { unlinked: true } });
    expect(svc.activityLogMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.tg_unlinked',
        entity_id: '7',
      }),
    );
    expect(
      await errorOf(make().telegramUnlinkUser({ user_id: 'abc' })),
    ).toEqual(expect.objectContaining({ statusCode: 401 }));
  });

  it('(4BirMSVp) linked_users — faqat ulangan, faol, o‘chirilmagan, berilgan rol; noto‘g‘ri rol 400', async () => {
    const svc = make();
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ user_id: 25, telegram_id: '5550007' }]),
    };
    Object.assign(svc.usersMock, { createQueryBuilder: jest.fn(() => qb) });
    const res = await svc.telegramLinkedUsers({ role: 'courier' });
    expect(qb.where).toHaveBeenCalledWith('u.telegram_id IS NOT NULL');
    expect(qb.andWhere).toHaveBeenCalledWith('u.role = :role', {
      role: 'courier',
    });
    expect(res.data).toEqual([{ user_id: '25', telegram_id: '5550007' }]);
    expect(await errorOf(svc.telegramLinkedUsers({ role: 'hacker' }))).toEqual(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('(gWI4gYkw) active_ids_by_role — faol superadminlar (ulanmaganlar ham), mijoz / noto‘g‘ri rol 400', async () => {
    const svc = make();
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { user_id: 1, telegram_id: '5550001' },
        { user_id: 2, telegram_id: null },
      ]),
    };
    Object.assign(svc.usersMock, { createQueryBuilder: jest.fn(() => qb) });
    const res = await svc.activeIdsByRole({ role: 'superadmin' });
    expect(qb.where).toHaveBeenCalledWith('u.is_deleted = false');
    expect(qb.andWhere).toHaveBeenCalledWith('u.role = :role', {
      role: 'superadmin',
    });
    expect(qb.andWhere).not.toHaveBeenCalledWith('u.telegram_id IS NOT NULL');
    expect(res.data).toEqual([
      { user_id: '1', telegram_linked: true },
      { user_id: '2', telegram_linked: false },
    ]);
    for (const role of ['hacker', 'customer']) {
      expect(await errorOf(svc.activeIdsByRole({ role }))).toEqual(
        expect.objectContaining({ statusCode: 400 }),
      );
    }
  });

  it('contactsByIds — telegram_id qaytadi (DM uchun), null ham', async () => {
    const svc = make(1, [
      {
        id: '7',
        phone_number: '+998901112233',
        role: Roles.COURIER,
        language: 'uz',
        settings: null,
        telegram_id: '5550007',
      },
      {
        id: '8',
        phone_number: null,
        role: Roles.MARKET,
        language: 'ru',
        settings: null,
        telegram_id: null,
      },
    ]);
    const res = (await svc.contactsByIds(['7', '8'])) as {
      data: Array<Record<string, unknown>>;
    };
    expect(svc.usersMock.find.mock.calls[0][0].select).toContain('telegram_id');
    expect(res.data.map((row) => row.telegram_id)).toEqual(['5550007', null]);
  });

  it('RMQ patternlari: telegram_bind / telegram_unbind / telegram.link / telegram.unlink / resolve_many / stats', () => {
    const proto = IdentityController.prototype as unknown as Record<
      string,
      object
    >;
    const cmds = Object.getOwnPropertyNames(proto).flatMap((name) => {
      const meta = Reflect.getMetadata(PATTERN_METADATA, proto[name]) as
        | Array<{ cmd?: string }>
        | undefined;
      return (meta ?? []).map((pattern) => pattern.cmd);
    });
    expect(cmds).toEqual(
      expect.arrayContaining([
        'identity.user.telegram_bind',
        'identity.user.telegram_unbind',
        'identity.telegram.link',
        'identity.telegram.unlink',
        'identity.telegram.resolve_many',
        'identity.telegram.stats',
        'identity.auth.telegram',
        'identity.auth.telegram_actor',
        'identity.telegram.linked_users',
      ]),
    );
  });
});
