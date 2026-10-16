import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { In } from 'typeorm';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { IdentityController } from './identity.controller';

/**
 * Bot RBAC darvozasi (3ZfiXuaW #1 / ZlpXb4Wh): `identity.telegram.resolve` —
 * telegram_id → aktor. FAIL-CLOSED: bog'lanmagan / nofaol / mijoz / investor /
 * bir nechta akkauntga bog'langan → `null` (throw emas).
 * `identity.telegram.linked_counts` — `bot_linked_users{role}` metrikasi.
 */
describe('identity — identity.telegram.resolve (bot aktori)', () => {
  const make = (rows: Array<Record<string, unknown>>) => {
    const users = {
      find: jest.fn().mockResolvedValue(rows),
      createQueryBuilder: jest.fn(),
    };
    const svc = Object.create(
      UserServiceService.prototype,
    ) as UserServiceService;
    Object.assign(svc, { users, logger: { warn: jest.fn() } });
    return Object.assign(svc, { usersMock: users });
  };
  const user = (overrides: Record<string, unknown> = {}) => ({
    id: '25',
    role: Roles.COURIER,
    status: Status.ACTIVE,
    market_id: null,
    region_id: '3',
    telegram_id: '5550007',
    ...overrides,
  });

  it('⭐ bog‘langan faol kuryer → aktor; so‘rov telegram_id bo‘yicha, o‘chirilganlarsiz', async () => {
    const svc = make([user()]);
    const res = await svc.telegramResolve({ telegram_id: 5550007 });
    expect(svc.usersMock.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegram_id: In(['5550007']), isDeleted: false },
      }),
    );
    expect(res.data).toEqual({
      user_id: '25',
      role: Roles.COURIER,
      status: Status.ACTIVE,
      market_id: null,
      region_id: '3',
    });
  });

  it('market — market_id o‘zi; market operatori — biriktirilgan market', async () => {
    expect(
      (
        await make([user({ id: '37', role: Roles.MARKET })]).telegramResolve({
          telegram_id: '5550007',
        })
      ).data,
    ).toEqual(expect.objectContaining({ user_id: '37', market_id: '37' }));
    expect(
      (
        await make([
          user({ id: '40', role: Roles.MARKET_OPERATOR, market_id: '37' }),
        ]).telegramResolve({
          telegram_id: '5550007',
        })
      ).data,
    ).toEqual(expect.objectContaining({ user_id: '40', market_id: '37' }));
  });

  it.each([
    ['bog‘lanmagan', []],
    ['nofaol', [user({ status: Status.INACTIVE })]],
    ['mijoz', [user({ role: Roles.CUSTOMER })]],
    ['investor', [user({ role: Roles.INVESTOR })]],
    ['ikki akkauntga bog‘langan (noaniq)', [user(), user({ id: '26' })]],
  ])('⭐ %s → null (fail-closed, throw emas)', async (_label, rows) => {
    const res = await make(rows).telegramResolve({ telegram_id: '5550007' });
    expect(res.data).toBeNull();
  });

  it('noto‘g‘ri telegram_id — DB’ga bormaydi, null', async () => {
    const svc = make([user()]);
    for (const telegram_id of ['abc', '', null, { $ne: 1 }]) {
      expect((await svc.telegramResolve({ telegram_id })).data).toBeNull();
    }
    expect(svc.usersMock.find).not.toHaveBeenCalled();
  });

  it('resolve_many — bir so‘rovda, har id uchun aktor yoki null', async () => {
    const svc = make([user(), user({ id: '26', telegram_id: '5550008', status: Status.INACTIVE })]);
    const res = await svc.telegramResolveMany({
      telegram_ids: ['5550007', '5550008', '5550009', 'bad'],
    });
    expect(res.data).toEqual({
      '5550007': expect.objectContaining({ user_id: '25' }),
      '5550008': null,
      '5550009': null,
    });
    expect(svc.usersMock.find).toHaveBeenCalledTimes(1);
  });

  it('linked_counts — rol bo‘yicha son', async () => {
    const svc = make([]);
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { role: 'courier', count: '3' },
        { role: 'market', count: '1' },
      ]),
    };
    svc.usersMock.createQueryBuilder.mockReturnValue(qb);
    const res = await svc.telegramLinkedCounts();
    expect(qb.where).toHaveBeenCalledWith('u.telegram_id IS NOT NULL');
    expect(res.data).toEqual([
      { role: 'courier', count: 3 },
      { role: 'market', count: 1 },
    ]);
  });

  it('RMQ naqshlari ro‘yxatdan o‘tgan', () => {
    const patterns = Object.getOwnPropertyNames(IdentityController.prototype)
      .map((name) => {
        const handler = Object.getOwnPropertyDescriptor(
          IdentityController.prototype,
          name,
        )?.value as object | undefined;
        return handler
          ? (Reflect.getMetadata(PATTERN_METADATA, handler) as unknown)
          : undefined;
      })
      .flat()
      .filter(Boolean)
      .map((pattern) => (pattern as { cmd?: string }).cmd);
    expect(patterns).toEqual(
      expect.arrayContaining([
        'identity.telegram.resolve',
        'identity.telegram.linked_counts',
      ]),
    );
  });
});
