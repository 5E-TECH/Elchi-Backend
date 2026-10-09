import { BranchServiceService } from './branch-service.service';

/** oNAE3LW9 — tuman/viloyatga bog'langan filiallar: sanoq va birlashtirishda ko'chirish. */
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

describe('BranchServiceService geo usage / reassign (oNAE3LW9)', () => {
  const make = (locked: Row[] = []) => {
    const svc: any = Object.create(BranchServiceService.prototype);
    const qb: any = {
      where: jest.fn(() => qb),
      getCount: jest.fn(() => Promise.resolve(2)),
    };
    svc.branchRepo = { createQueryBuilder: jest.fn(() => qb) };
    const tx = attachTx(svc.branchRepo, locked);
    return { svc, qb, ...tx };
  };

  it('tuman va viloyat bo`yicha sanaydi; ikkalasi ham yo`q — 400', async () => {
    const { svc, qb } = make();
    const byDistrict = await svc.countGeoUsage({ district_id: '173' });
    expect(qb.where).toHaveBeenCalledWith('b.district_id = :districtId', {
      districtId: '173',
    });
    expect(byDistrict.data.branches).toBe(2);
    await svc.countGeoUsage({ region_id: '3' });
    expect(qb.where).toHaveBeenCalledWith('b.region_id = :regionId', {
      regionId: '3',
    });
    expect(await statusOf(svc.countGeoUsage({}))).toBe(400);
  });

  it('⭐ reassign A → B: ko`chgan ID lar qaytadi; kompensatsiya rejimi aynan tiklaydi', async () => {
    const forward = make([{ id: '7', region_id: '3' }]);
    const res = await forward.svc.reassignDistrict({
      from_district_id: '173',
      to_district_id: '28',
      to_region_id: '4',
    });
    expect(forward.updates).toEqual([
      {
        set: { district_id: '28', region_id: '4' },
        where: 'id = ANY(:ids)',
        params: { ids: ['7'] },
      },
    ]);
    expect(res.data).toEqual(
      expect.objectContaining({
        moved: 1,
        ids: ['7'],
        previous_regions: [{ region_id: '3', ids: ['7'] }],
      }),
    );

    const back = make([{ id: '7', region_id: '4' }]);
    await back.svc.reassignDistrict({
      from_district_id: '28',
      to_district_id: '173',
      ids: ['7'],
      restore_regions: [{ region_id: '3', ids: ['7'] }],
    });
    expect(back.updates).toEqual([
      {
        set: { district_id: '173' },
        where: 'id = ANY(:ids)',
        params: { ids: ['7'] },
      },
      {
        set: { region_id: '3' },
        where: 'id = ANY(:ids)',
        params: { ids: ['7'] },
      },
    ]);
  });

  it('deadline_at o`tgan → 409', async () => {
    const { svc } = make([{ id: '7', region_id: '3' }]);
    expect(
      await statusOf(
        svc.reassignDistrict({
          from_district_id: '173',
          to_district_id: '28',
          deadline_at: Date.now() - 1,
        }),
      ),
    ).toBe(409);
  });
});
