import { UserServiceService } from './user-service.service';

/** oNAE3LW9 — tumanga bog'langan foydalanuvchilar (mijoz/kuryer/market). */
type Row = { id: string; region_id: string | null };

/** `repo.manager.transaction` — SELECT ... FOR UPDATE va UPDATE'lar yoziladi. */
function attachTx(repo: any, locked: Row[]) {
  const selectQb: any = {
    select: jest.fn(() => selectQb),
    addSelect: jest.fn(() => selectQb),
    where: jest.fn(() => selectQb),
    andWhere: jest.fn(() => selectQb),
    setLock: jest.fn(() => selectQb),
    getRawMany: jest.fn(() => Promise.resolve(locked)),
  };
  const updates: Array<{ set: unknown; where: string; params: unknown }> = [];
  const manager: any = {
    getRepository: jest.fn(() => ({
      createQueryBuilder: jest.fn(() => selectQb),
    })),
    createQueryBuilder: jest.fn(() => {
      const entry: any = {};
      const u: any = {
        update: jest.fn(() => u),
        set: jest.fn((value: unknown) => {
          entry.set = value;
          return u;
        }),
        where: jest.fn((where: string, params: unknown) => {
          entry.where = where;
          entry.params = params;
          return u;
        }),
        execute: jest.fn(() => {
          updates.push(entry);
          return Promise.resolve({ affected: 1 });
        }),
      };
      return u;
    }),
  };
  repo.manager = {
    transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };
  return { selectQb, updates };
}

const statusOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e: any) {
    return e?.getError?.()?.statusCode;
  }
};

describe('UserServiceService geo usage / reassign (oNAE3LW9)', () => {
  const make = (locked: Row[] = []) => {
    const svc: any = Object.create(UserServiceService.prototype);
    const qb: any = {
      select: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      where: jest.fn(() => qb),
      groupBy: jest.fn(() => qb),
      getRawMany: jest.fn(() =>
        Promise.resolve([
          { role: 'customer', count: '7' },
          { role: 'courier', count: '1' },
        ]),
      ),
    };
    svc.users = { createQueryBuilder: jest.fn(() => qb) };
    const tx = attachTx(svc.users, locked);
    return { svc, qb, ...tx };
  };

  it('rol kesimida sanaydi va jami beradi', async () => {
    const { svc } = make();
    const res = await svc.countGeoUsage({ district_id: '173' });
    expect(res.data.users).toBe(8);
    expect(res.data.by_role).toEqual({ customer: 7, courier: 1 });
  });

  it('⭐ reassign A → B: qulflab ko`chiradi, ko`chgan ID + eski viloyatlarni qaytaradi', async () => {
    const { svc, selectQb, updates } = make([
      { id: '301', region_id: '3' },
      { id: '302', region_id: '3' },
    ]);
    const res = await svc.reassignDistrict({
      from_district_id: '173',
      to_district_id: '28',
      to_region_id: '4',
    });
    expect(selectQb.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(updates).toEqual([
      {
        set: { district_id: '28', region_id: '4' },
        where: 'id = ANY(:ids)',
        params: { ids: ['301', '302'] },
      },
    ]);
    expect(res.data.moved).toBe(2);
    expect(res.data.ids).toEqual(['301', '302']);
    expect(res.data.previous_regions).toEqual([
      { region_id: '3', ids: ['301', '302'] },
    ]);
  });

  it('⭐ ID rejimi (kompensatsiya): faqat berilgan ID lar, region_id qator bo`yicha tiklanadi', async () => {
    const { svc, selectQb, updates } = make([{ id: '301', region_id: '4' }]);
    const res = await svc.reassignDistrict({
      from_district_id: '28',
      to_district_id: '173',
      ids: ['301', '302'],
      restore_regions: [{ region_id: '3', ids: ['301', '302'] }],
    });
    expect(selectQb.andWhere).toHaveBeenCalledWith('t.id = ANY(:ids)', {
      ids: ['301', '302'],
    });
    expect(updates).toEqual([
      {
        set: { district_id: '173' },
        where: 'id = ANY(:ids)',
        params: { ids: ['301'] },
      },
      {
        set: { region_id: '3' },
        where: 'id = ANY(:ids)',
        params: { ids: ['301'] },
      },
    ]);
    expect(res.data.missing_ids).toEqual(['302']);
  });

  it('o`ziga → 400; deadline_at o`tgan → 409 (DB ga tegilmaydi)', async () => {
    const { svc, selectQb } = make([{ id: '301', region_id: '3' }]);
    expect(
      await statusOf(
        svc.reassignDistrict({ from_district_id: '1', to_district_id: '1' }),
      ),
    ).toBe(400);
    expect(
      await statusOf(
        svc.reassignDistrict({
          from_district_id: '173',
          to_district_id: '28',
          deadline_at: Date.now() - 1,
        }),
      ),
    ).toBe(409);
    expect(selectQb.getRawMany).not.toHaveBeenCalled();
  });
});
