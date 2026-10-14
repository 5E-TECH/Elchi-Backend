import { Roles } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * nFmup26a — findAllAdmins meta (unit; haqiqiy SQL — user-service.stats.pg.spec.ts).
 * GROUP BY natijasidan: totalMarket + totalEmployees === totalUsers va
 * countsByRole Roles enum'ining har bir qiymatini qamraydi.
 */
function makeService(rawRows: Array<{ role: string; count: string }>) {
  const qb: Record<string, unknown> = {};
  const chain = () => qb;
  Object.assign(qb, {
    where: chain,
    andWhere: chain,
    orderBy: chain,
    skip: chain,
    take: chain,
    clone: chain,
    select: chain,
    addSelect: chain,
    groupBy: chain,
    getManyAndCount: () => Promise.resolve([[], 0]),
    getRawMany: () => Promise.resolve(rawRows),
  });
  const noopClient = { send: jest.fn(), emit: jest.fn() };
  return new UserServiceService(
    { createQueryBuilder: jest.fn(() => qb) } as never,
    noopClient as never,
    noopClient as never,
    noopClient as never,
    noopClient as never,
    noopClient as never,
    noopClient as never,
    { encrypt: jest.fn(), compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
  );
}

const metaOf = async (rows: Array<{ role: string; count: string }>) =>
  ((await makeService(rows).findAllAdmins({})) as any).data.meta;

describe('nFmup26a — findAllAdmins statistika kartalari', () => {
  it('35 foydalanuvchi (market 11, manager 11, courier 10, registrator 2, admin 1): 11 + 24 = 35', async () => {
    const meta = await metaOf([
      { role: 'market', count: '11' },
      { role: 'manager', count: '11' },
      { role: 'courier', count: '10' },
      { role: 'registrator', count: '2' },
      { role: 'admin', count: '1' },
    ]);
    expect(meta.totalUsers).toBe(35);
    expect(meta.totalMarket).toBe(11);
    expect(meta.totalEmployees).toBe(24);
    expect(meta.totalMarket + meta.totalEmployees).toBe(meta.totalUsers);
  });

  it('yangi rollar (branch/investor/logist) bilan ham invariant saqlanadi', async () => {
    const meta = await metaOf([
      { role: 'market', count: '3' },
      { role: 'branch', count: '2' },
      { role: 'investor', count: '1' },
      { role: 'logist', count: '4' },
      { role: 'operator', count: '5' },
      { role: 'market_operator', count: '6' },
    ]);
    expect(meta.totalUsers).toBe(21);
    expect(meta.totalEmployees).toBe(18);
    expect(meta.totalMarket + meta.totalEmployees).toBe(meta.totalUsers);
  });

  it('countsByRole — Roles enum qiymatlarining hammasi (yo‘q rol 0)', async () => {
    const meta = await metaOf([{ role: 'manager', count: '2' }]);
    expect(Object.keys(meta.countsByRole).sort()).toEqual(
      Object.values(Roles).map(String).sort(),
    );
    expect(meta.countsByRole[Roles.MANAGER]).toBe(2);
    expect(meta.countsByRole[Roles.MARKET]).toBe(0);
  });
});
