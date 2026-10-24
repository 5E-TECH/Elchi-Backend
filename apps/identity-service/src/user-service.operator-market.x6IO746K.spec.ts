import { FindOperator } from 'typeorm';
import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * x6IO746K — market operatori qatorida market nomi:
 *   - GET /users (`findAllAdmins`): `role = market_operator` qatorlariga
 *     `market: { id, name } | null` — sahifa bo'yicha BITTA IN so'rovi;
 *   - GET /users/:id (gateway `include_branch`): xuddi shu;
 *   - GET /auth/my-profile (N13): operatorga `market: { id, name, add_order }`.
 * Market o'chirilgan / topilmagan — null; maxfiy market maydonlari yo'q.
 */
type Row = Record<string, unknown>;

const operator = (id: string, marketId: string | null): Row => ({
  id,
  name: `Operator ${id}`,
  role: Roles.MARKET_OPERATOR,
  market_id: marketId,
  status: Status.ACTIVE,
  password: 'hash',
  refresh_token: 'rt',
});

const MARKETS: Row[] = [
  {
    id: '37',
    name: 'Baraka Shop',
    add_order: true,
    market_tg_token: 'SECRET',
    tariff_home: 20000,
  },
];

function makeService(pageRows: Row[] = [], single: Row | null = null) {
  const qb: Record<string, unknown> = {};
  Object.assign(qb, {
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    skip: () => qb,
    take: () => qb,
    clone: () => qb,
    select: () => qb,
    addSelect: () => qb,
    groupBy: () => qb,
    getManyAndCount: () =>
      Promise.resolve([pageRows.map((r) => ({ ...r })), pageRows.length]),
    getRawMany: () => Promise.resolve([]),
  });
  const find = jest.fn((options: { where: { id: FindOperator<string[]> } }) => {
    const ids = options.where.id.value as unknown as string[];
    // Faqat so'ralgan maydonlar (select) — haqiqiy repo kabi.
    return Promise.resolve(
      MARKETS.filter((m) => ids.includes(String(m.id))).map((m) => ({
        id: m.id,
        name: m.name,
        add_order: m.add_order,
      })),
    );
  });
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    find,
    findOne: jest.fn(() => Promise.resolve(single ? { ...single } : null)),
  };
  const send = jest.fn(() => of({ data: null }));
  const service = new UserServiceService(
    repo as never,
    { send } as never, // search
    { send } as never, // catalog
    { send } as never, // order
    { send } as never, // logistics
    { send } as never, // finance
    { send } as never, // branch
    { encrypt: jest.fn(), compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
  );
  return { service, find };
}

type FindArgs = {
  where: { id: FindOperator<string[]>; role: string; isDeleted: boolean };
  select: Record<string, boolean>;
};

describe('x6IO746K — GET /users: operator qatorida market', () => {
  it('⭐ bitta IN so`rovi (takrorsiz), faqat operator qatorlarida market', async () => {
    const { service, find } = makeService([
      operator('201', '37'),
      operator('202', '37'),
      operator('203', '50'), // o'chirilgan / topilmagan market
      operator('204', null), // biriktirilmagan
      { id: '37', role: Roles.MARKET, name: 'Baraka Shop', market_id: null },
      { id: '26', role: Roles.COURIER, name: 'Kuryer', market_id: null },
    ]);

    const res = (await service.findAllAdmins({ limit: 10 })) as {
      data: { items: Row[] };
    };

    expect(find).toHaveBeenCalledTimes(1);
    const [[args]] = find.mock.calls as unknown as Array<[FindArgs]>;
    expect(args.where.id.value).toEqual(['37', '50']);
    expect(args.where.role).toBe(Roles.MARKET);
    expect(args.where.isDeleted).toBe(false);
    // Maxfiy maydonlar umuman o'qilmaydi (GvL6ZFAd).
    expect(args.select).toEqual({ id: true, name: true, add_order: true });

    const byId = new Map(res.data.items.map((row) => [row.id, row]));
    expect(byId.get('201')!.market).toStrictEqual({
      id: '37',
      name: 'Baraka Shop',
    });
    expect(byId.get('202')!.market).toStrictEqual({
      id: '37',
      name: 'Baraka Shop',
    });
    expect(byId.get('203')!.market).toBeNull();
    expect(byId.get('204')!.market).toBeNull();
    expect(byId.get('37')).not.toHaveProperty('market');
    expect(byId.get('26')).not.toHaveProperty('market');
    expect(byId.get('201')).not.toHaveProperty('password');
  });

  it('sahifada operator yo`q — market so`rovi yo`q', async () => {
    const { service, find } = makeService([
      { id: '26', role: Roles.COURIER, name: 'Kuryer' },
    ]);
    await service.findAllAdmins({});
    expect(find).not.toHaveBeenCalled();
  });
});

describe('x6IO746K — GET /users/:id: operator marketi', () => {
  it('⭐ include_branch: market { id, name }', async () => {
    const { service, find } = makeService([], operator('201', '37'));

    const res = (await service.findUserById('201', {
      includeBranch: true,
    })) as { data: Row };

    expect(res.data.market).toStrictEqual({ id: '37', name: 'Baraka Shop' });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('market o`chirilgan — market: null', async () => {
    const { service } = makeService([], operator('203', '50'));
    const res = (await service.findUserById('203', {
      includeBranch: true,
    })) as { data: Row };
    expect(res.data).toHaveProperty('market', null);
  });

  it('ichki chaqiruv (flagsiz) — market kaliti va so`rovi yo`q', async () => {
    const { service, find } = makeService([], operator('201', '37'));
    const res = (await service.findUserById('201')) as { data: Row };
    expect(res.data).not.toHaveProperty('market');
    expect(find).not.toHaveBeenCalled();
  });

  it('operator bo`lmagan rol — market kaliti yo`q', async () => {
    const { service, find } = makeService([], {
      id: '26',
      role: Roles.COURIER,
      name: 'Kuryer',
      market_id: '37',
    });
    const res = (await service.findUserById('26', {
      includeBranch: true,
    })) as { data: Row };
    expect(res.data).not.toHaveProperty('market');
    expect(find).not.toHaveBeenCalled();
  });
});

describe('x6IO746K (N13) — GET /auth/my-profile: operator marketi', () => {
  it('⭐ market { id, name, add_order }', async () => {
    const { service } = makeService([], operator('201', '37'));

    const res = (await service.findOwnProfile('201')) as { data: Row };

    expect(res.data.market).toStrictEqual({
      id: '37',
      name: 'Baraka Shop',
      add_order: true,
    });
  });

  it('market o`chirilgan — market: null', async () => {
    const { service } = makeService([], operator('203', '50'));
    const res = (await service.findOwnProfile('203')) as { data: Row };
    expect(res.data).toHaveProperty('market', null);
  });

  it('boshqa rol (market o`zi) — market kaliti yo`q, so`rov yo`q', async () => {
    const { service, find } = makeService([], {
      id: '37',
      role: Roles.MARKET,
      name: 'Baraka Shop',
      market_id: null,
    });
    const res = (await service.findOwnProfile('37')) as { data: Row };
    expect(res.data).not.toHaveProperty('market');
    expect(find).not.toHaveBeenCalled();
  });
});
