import { RpcException } from '@nestjs/microservices';
import { OrderServiceService } from './order-service.service';

/**
 * oNAE3LW9 — hudud o'chirish himoyasi uchun buyurtma sanog'i va tumanlarni
 * birlashtirishdagi ko'chirish (ID qaytaradi + kompensatsiya rejimi).
 */
type Row = { id: string; region_id: string | null };

function make(locked: Row[] = []) {
  const svc: any = Object.create(OrderServiceService.prototype);
  // countGeoUsage — buyurtmalar.
  const countQb: any = {
    where: jest.fn(() => countQb),
    getCount: jest.fn(() => Promise.resolve(5)),
  };
  svc.orderRepo = { createQueryBuilder: jest.fn(() => countQb) };
  // countGeoUsage — filiallararo jo'natmalar (viloyat bo'yicha).
  const batchQb: any = {
    where: jest.fn(() => batchQb),
    getCount: jest.fn(() => Promise.resolve(2)),
  };
  svc.transferBatchRepo = { createQueryBuilder: jest.fn(() => batchQb) };

  // reassignDistrict — tranzaksiya ichidagi SELECT ... FOR UPDATE va UPDATE'lar.
  const selectQb: any = {
    select: jest.fn(() => selectQb),
    addSelect: jest.fn(() => selectQb),
    where: jest.fn(() => selectQb),
    andWhere: jest.fn(() => selectQb),
    setLock: jest.fn(() => selectQb),
    getRawMany: jest.fn(() => Promise.resolve(locked)),
  };
  const updates: Array<{ set: unknown; where: string; params: unknown }> = [];
  let failUpdate: Error | null = null;
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
          if (failUpdate) return Promise.reject(failUpdate);
          updates.push(entry);
          return Promise.resolve({ affected: 1 });
        }),
      };
      return u;
    }),
  };
  const tx = { committed: false, rolledBack: false };
  svc.orderRepo.manager = {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => {
      try {
        const result = await cb(manager);
        tx.committed = true;
        return result;
      } catch (error) {
        tx.rolledBack = true;
        throw error;
      }
    }),
  };
  return {
    svc,
    countQb,
    batchQb,
    selectQb,
    updates,
    tx,
    failUpdateWith: (e: Error) => (failUpdate = e),
  };
}

const statusOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e: any) {
    return e instanceof RpcException
      ? (e.getError() as { statusCode?: number })?.statusCode
      : -1;
  }
};

describe('OrderServiceService.countGeoUsage (oNAE3LW9)', () => {
  it('district_id bo`yicha sanaydi (o`chirilganlar ham — is_deleted filtri yo`q); jo`natma sanalmaydi', async () => {
    const { svc, countQb, batchQb } = make();
    const res = await svc.countGeoUsage({ district_id: '173' });
    expect(countQb.where).toHaveBeenCalledWith('o.district_id = :districtId', {
      districtId: '173',
    });
    expect(res.data.orders).toBe(5);
    expect(res.data.transfer_batches).toBe(0);
    expect(batchQb.getCount).not.toHaveBeenCalled();
  });

  it('region_id bo`yicha: buyurtmalar + branch_transfer_batches.target_region_id', async () => {
    const { svc, countQb, batchQb } = make();
    const res = await svc.countGeoUsage({ region_id: '3' });
    expect(countQb.where).toHaveBeenCalledWith('o.region_id = :regionId', {
      regionId: '3',
    });
    expect(batchQb.where).toHaveBeenCalledWith(
      'b.target_region_id = :regionId',
      { regionId: '3' },
    );
    expect(res.data).toEqual(
      expect.objectContaining({ orders: 5, transfer_batches: 2 }),
    );
  });

  it('ikkalasi ham bo`lmasa 400', async () => {
    const { svc } = make();
    expect(await statusOf(svc.countGeoUsage({}))).toBe(400);
  });
});

describe('OrderServiceService.reassignDistrict (oNAE3LW9 TC5)', () => {
  const rows: Row[] = [
    { id: '11', region_id: '3' },
    { id: '12', region_id: '3' },
    { id: '13', region_id: null },
  ];

  it('⭐ A → B: bitta tranzaksiyada qulflab ko`chiradi va ko`chgan ID + eski viloyatlarni qaytaradi', async () => {
    const { svc, selectQb, updates, tx } = make(rows);
    const res = await svc.reassignDistrict({
      from_district_id: '173',
      to_district_id: '28',
      to_region_id: '4',
    });
    expect(selectQb.where).toHaveBeenCalledWith('t.district_id = :from', {
      from: '173',
    });
    expect(selectQb.andWhere).not.toHaveBeenCalled();
    expect(selectQb.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(updates).toEqual([
      {
        set: { district_id: '28', region_id: '4' },
        where: 'id = ANY(:ids)',
        params: { ids: ['11', '12', '13'] },
      },
    ]);
    expect(tx.committed).toBe(true);
    expect(res.data).toEqual({
      from_district_id: '173',
      to_district_id: '28',
      moved: 3,
      ids: ['11', '12', '13'],
      previous_regions: [
        { region_id: '3', ids: ['11', '12'] },
        { region_id: null, ids: ['13'] },
      ],
      missing_ids: [],
    });
  });

  it('⭐ ID rejimi (kompensatsiya B → A): faqat shu ID lar, region_id AYNAN tiklanadi, topilmagani missing_ids da', async () => {
    const { svc, selectQb, updates } = make([
      { id: '11', region_id: '4' },
      { id: '13', region_id: '4' },
    ]);
    const res = await svc.reassignDistrict({
      from_district_id: '28',
      to_district_id: '173',
      ids: ['11', '12', '13'],
      restore_regions: [
        { region_id: '3', ids: ['11', '12'] },
        { region_id: null, ids: ['13'] },
      ],
    });
    expect(selectQb.andWhere).toHaveBeenCalledWith('t.id = ANY(:ids)', {
      ids: ['11', '12', '13'],
    });
    expect(updates).toEqual([
      // region tegilmaydi (to_region_id yo'q) — keyin qator bo'yicha tiklanadi
      {
        set: { district_id: '173' },
        where: 'id = ANY(:ids)',
        params: { ids: ['11', '13'] },
      },
      {
        set: { region_id: '3' },
        where: 'id = ANY(:ids)',
        params: { ids: ['11'] },
      },
      {
        set: { region_id: null },
        where: 'id = ANY(:ids)',
        params: { ids: ['13'] },
      },
    ]);
    expect(res.data.ids).toEqual(['11', '13']);
    expect(res.data.missing_ids).toEqual(['12']);
  });

  it('ID rejimi bo`sh ro`yxat bilan — DB ga tegmaydi, 0 ko`chadi', async () => {
    const { svc, selectQb, updates } = make(rows);
    const res = await svc.reassignDistrict({
      from_district_id: '28',
      to_district_id: '173',
      ids: [],
    });
    expect(selectQb.getRawMany).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(res.data.moved).toBe(0);
  });

  it('deadline_at o`tgan — 409, DB ga tegilmaydi (kech ko`chish yo`q)', async () => {
    const { svc, selectQb } = make(rows);
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

  it('deadline_at tranzaksiya davomida o`tsa — COMMIT qilinmaydi (rollback, 409)', async () => {
    const { svc, selectQb, tx } = make(rows);
    const deadline = Date.now() + 60_000;
    selectQb.getRawMany.mockImplementation(() => {
      jest.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      return Promise.resolve(rows);
    });
    try {
      expect(
        await statusOf(
          svc.reassignDistrict({
            from_district_id: '173',
            to_district_id: '28',
            deadline_at: deadline,
          }),
        ),
      ).toBe(409);
      expect(tx.rolledBack).toBe(true);
      expect(tx.committed).toBe(false);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('kutilmagan DB xatosi RpcException 503 ga o`raladi (RMQ qayta navbatga qo`ymasin)', async () => {
    const { svc, failUpdateWith, tx } = make(rows);
    failUpdateWith(new Error('connection terminated'));
    expect(
      await statusOf(
        svc.reassignDistrict({ from_district_id: '173', to_district_id: '28' }),
      ),
    ).toBe(503);
    expect(tx.rolledBack).toBe(true);
  });

  it('noto`g`ri kirish → 400: o`ziga, raqam emas, buzuq ids/restore_regions', async () => {
    const { svc } = make(rows);
    const bad = [
      { from_district_id: '1', to_district_id: '1' },
      { from_district_id: 'abc', to_district_id: '2' },
      { from_district_id: '1', to_district_id: '2', ids: ['x'] },
      { from_district_id: '1', to_district_id: '2', ids: 'not-array' },
      {
        from_district_id: '1',
        to_district_id: '2',
        restore_regions: [{ region_id: 'x', ids: ['1'] }],
      },
    ];
    for (const input of bad) {
      expect(await statusOf(svc.reassignDistrict(input))).toBe(400);
    }
  });
});
