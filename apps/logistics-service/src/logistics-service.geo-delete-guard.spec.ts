import { Observable, of, throwError } from 'rxjs';
import { Not } from 'typeorm';
import { ACTIVITY_ACTION_REGISTRY, publicErrorData } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * oNAE3LW9 — viloyat/tuman o'chirilganda himoya va tumanlarni birlashtirish.
 * Ilgari `remove` hech narsa tekshirmasdan chaqirilardi: buyurtmalar (boshqa
 * sxema, FK yo'q) yetim qolardi, viloyat o'chsa `District.region_id` CASCADE
 * tufayli uning BARCHA tumanlari ham o'chardi.
 *
 * Order/identity/branch servislari XOTIRADAGI model bilan almashtirilgan:
 * sanoq va ko'chirish (oddiy + ID/kompensatsiya rejimi) haqiqiy holat ustida
 * bajariladi — "aynan o'sha ID'lar qaytdimi" tekshiriladi.
 */
type Kind = 'orders' | 'users' | 'branches';
type GeoRow = {
  id: string;
  district_id: string;
  region_id: string | null;
  /** oNAE3LW9 (prod 2-tur): o'chirilgan (is_deleted / deleted_at) yozuv. */
  deleted?: boolean;
};
type Fault = 'timeout' | 'timeout_after_move' | { statusCode: number };

const CMD: Record<Kind, { usage: string; move: string }> = {
  orders: { usage: 'order.geo.usage', move: 'order.geo.reassign_district' },
  users: {
    usage: 'identity.user.geo_usage',
    move: 'identity.user.reassign_district',
  },
  branches: { usage: 'branch.geo_usage', move: 'branch.reassign_district' },
};

const timeoutError = () =>
  Object.assign(new Error('Timeout has occurred'), { name: 'TimeoutError' });

function make(
  opts: {
    rows?: Partial<Record<Kind, GeoRow[]>>;
    /** order_schema.branch_transfer_batches.target_region_id */
    batches?: string[];
    /** O'chirilgan (is_deleted) jo'natmalar — viloyat ID lari. */
    deletedBatches?: string[];
    /** Eski order-service: `transfer_batches` maydonini qaytarmaydi. */
    legacyOrderUsage?: boolean;
    /**
     * oNAE3LW9 (prod 2-tur) — eski servislar: `deleted_*` maydoni yo'q,
     * o'chirilganlar asosiy maydonda sanaladi.
     */
    legacyDeletedFields?: boolean;
    /** Shu tur `deleted_*` maydonini buzuq qaytaradi. */
    badDeletedField?: Kind;
    usageDown?: boolean;
    posts?: number;
    regionDistricts?: number;
    /**
     * Boshqa viloyatlardan shu viloyatga biriktirilgan tumanlar
     * (`assigned_region = id AND region_id != id`).
     */
    assignedDistricts?: number;
    /** Oddiy (A → B) ko'chirish yiqilishi. */
    forwardFault?: Partial<Record<Kind, Fault>>;
    /** Kompensatsiya (ID rejimi, B → A) yiqilishi. */
    compensateFault?: Partial<Record<Kind, Fault>>;
    /** Oddiy ko'chirishdan keyin (parallel yozuv simulyatsiyasi). */
    afterForward?: (kind: Kind, rows: Record<Kind, GeoRow[]>) => void;
    removeFails?: boolean;
    /** (vsmpTweI) Eski servis: `moved_live` qaytarmaydi. */
    legacyMovedLive?: boolean;
  } = {},
) {
  const svc: any = Object.create(LogisticsServiceService.prototype);
  const rows: Record<Kind, GeoRow[]> = {
    orders: opts.rows?.orders ?? [],
    users: opts.rows?.users ?? [],
    branches: opts.rows?.branches ?? [],
  };
  const districts: Record<string, any> = {
    '173': {
      id: '173',
      name: 'Andijon shahri',
      sato_code: '1',
      region_id: '3',
    },
    '28': { id: '28', name: 'Andijon', sato_code: '2', region_id: '3' },
    '50': { id: '50', name: 'Chilonzor', sato_code: '5', region_id: '9' },
  };
  svc.districtRepo = {
    findOne: jest.fn(({ where }: any) => {
      const d = districts[String(where.id)];
      return Promise.resolve(d ? { ...d } : null);
    }),
    // TypeORM kabi: o'chirgandan keyin entity `id` si undefined bo'ladi.
    remove: jest.fn((d: any) => {
      delete districts[String(d.id)];
      d.id = undefined;
      return Promise.resolve(d);
    }),
    // `where` ga qarab: biriktirilganlar (`assigned_region`) yoki geografik.
    count: jest.fn(({ where }: { where?: { assigned_region?: unknown } }) =>
      Promise.resolve(
        where?.assigned_region !== undefined
          ? (opts.assignedDistricts ?? 0)
          : (opts.regionDistricts ?? 0),
      ),
    ),
    manager: {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => {
        const pending: string[] = [];
        const manager = {
          remove: jest.fn((d: any) => {
            if (opts.removeFails) {
              return Promise.reject(new Error('db connection lost'));
            }
            pending.push(String(d.id));
            d.id = undefined;
            return Promise.resolve(d);
          }),
        };
        const result = await cb(manager); // yiqilsa — rollback (pending bekor)
        for (const id of pending) delete districts[id];
        return result;
      }),
    },
  };
  svc.regionRepo = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: '3', name: 'Andijon', sato_code: '17' }),
    ),
    remove: jest.fn((r: any) => {
      r.id = undefined;
      return Promise.resolve(r);
    }),
  };
  svc.postRepo = { count: jest.fn(() => Promise.resolve(opts.posts ?? 0)) };
  svc.activityLog = { log: jest.fn(() => Promise.resolve()) };
  svc.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  svc.searchClient = { send: jest.fn(() => of({})) };

  const calls: Array<{ cmd: string; payload: any }> = [];
  const fail = (fault: Fault): Observable<never> =>
    throwError(() =>
      fault === 'timeout' || fault === 'timeout_after_move'
        ? timeoutError()
        : { statusCode: fault.statusCode, message: 'servis rad etdi' },
    );

  const usage = (kind: Kind, where: any) => {
    if (opts.usageDown) return throwError(() => timeoutError());
    const list = rows[kind].filter((r) =>
      where.district_id
        ? r.district_id === String(where.district_id)
        : r.region_id === String(where.region_id),
    );
    const live = list.filter((r) => !r.deleted).length;
    const data: Record<string, unknown> = opts.legacyDeletedFields
      ? { [kind]: list.length }
      : { [kind]: live, [`deleted_${kind}`]: list.length - live };
    if (opts.badDeletedField === kind) data[`deleted_${kind}`] = 'abc';
    if (kind === 'orders' && !opts.legacyOrderUsage) {
      const inRegion = (ids?: string[]) =>
        where.district_id
          ? 0
          : (ids ?? []).filter((r) => r === String(where.region_id)).length;
      data.transfer_batches = inRegion(opts.batches);
      if (!opts.legacyDeletedFields) {
        data.deleted_transfer_batches = inRegion(opts.deletedBatches);
      }
    }
    return of({ statusCode: 200, data });
  };

  const move = (kind: Kind, p: any) => {
    const compensation = Array.isArray(p.ids);
    const fault = (compensation ? opts.compensateFault : opts.forwardFault)?.[
      kind
    ];
    if (fault && fault !== 'timeout_after_move') return fail(fault);
    const wanted = compensation ? new Set(p.ids.map(String)) : null;
    const moved = rows[kind].filter(
      (r) =>
        r.district_id === p.from_district_id && (!wanted || wanted.has(r.id)),
    );
    const groups = new Map<
      string,
      { region_id: string | null; ids: string[] }
    >();
    for (const r of moved) {
      const key = r.region_id ?? '';
      const g = groups.get(key) ?? { region_id: r.region_id, ids: [] };
      g.ids.push(r.id);
      groups.set(key, g);
      r.district_id = p.to_district_id;
      if (p.to_region_id) r.region_id = p.to_region_id;
    }
    for (const g of p.restore_regions ?? []) {
      for (const r of moved)
        if (g.ids.includes(r.id)) r.region_id = g.region_id;
    }
    if (!compensation) opts.afterForward?.(kind, rows);
    if (fault === 'timeout_after_move') return fail(fault);
    const ids = moved.map((r) => r.id);
    return of({
      statusCode: 200,
      data: {
        moved: ids.length,
        // (vsmpTweI) haqiqiy servislar kabi: ko'chganlardan tiriklari.
        ...(opts.legacyMovedLive
          ? {}
          : { moved_live: moved.filter((r) => !r.deleted).length }),
        ids,
        previous_regions: [...groups.values()],
        missing_ids: compensation
          ? p.ids.filter((id: string) => !ids.includes(id))
          : [],
      },
    });
  };

  const client = (kind: Kind) => ({
    send: jest.fn((pattern: { cmd: string }, payload: any) => {
      calls.push({ cmd: pattern.cmd, payload });
      if (pattern.cmd === CMD[kind].usage) return usage(kind, payload);
      if (pattern.cmd === CMD[kind].move) return move(kind, payload);
      return of({});
    }),
  });
  svc.orderClient = client('orders');
  svc.identityClient = client('users');
  svc.branchClient = client('branches');

  const inDistrict = (kind: Kind, districtId: string) =>
    rows[kind].filter((r) => r.district_id === districtId).map((r) => r.id);
  return { svc, rows, districts, calls, inDistrict };
}

const order = (
  id: string,
  district_id: string,
  region_id: string | null,
  deleted = false,
): GeoRow => ({
  id,
  district_id,
  region_id,
  ...(deleted ? { deleted: true } : {}),
});
/** A (#173) da 5 ta buyurtma (biri region_id = null), B (#28) da 3 ta. */
const fiveInA = () => [
  order('11', '173', '3'),
  order('12', '173', '3'),
  order('13', '173', '3'),
  order('14', '173', '3'),
  order('15', '173', null),
  order('91', '28', '3'),
  order('92', '28', '3'),
  order('93', '28', '3'),
];

const errorOf = async (p: Promise<unknown>): Promise<any> => {
  try {
    await p;
    return undefined;
  } catch (e: any) {
    return e?.getError?.() ?? e;
  }
};
const statusOf = async (p: Promise<unknown>) => (await errorOf(p))?.statusCode;

describe('deleteDistrict — himoya (oNAE3LW9)', () => {
  it('⭐ TC1: buyurtmasi bor tuman → 400, tuman DB da qoladi', async () => {
    const { svc, districts } = make({ rows: { orders: fiveInA() } });
    expect(await statusOf(svc.deleteDistrict('173'))).toBe(400);
    expect(svc.districtRepo.remove).not.toHaveBeenCalled();
    expect(districts['173']).toBeDefined();
  });

  it('⭐ TC2: buyurtmasi yo`q tuman → 200 va DB dan (qattiq) o`chadi; qidiruvdan ham', async () => {
    const { svc, districts } = make();
    const res = await svc.deleteDistrict('173');
    expect(res.statusCode).toBe(200);
    expect(districts['173']).toBeUndefined();
    // `remove` id ni undefined qilsa ham qidiruv indeksiga ASL id ketadi.
    expect(svc.searchClient.send).toHaveBeenCalledWith(
      { cmd: 'search.index.remove' },
      expect.objectContaining({ type: 'district', sourceId: '173' }),
    );
  });

  it('⭐ TC4: kuryer (foydalanuvchi) district_id ko`rsatgan tuman → 400', async () => {
    const { svc } = make({ rows: { users: [order('301', '173', '3')] } });
    expect(await statusOf(svc.deleteDistrict('173'))).toBe(400);
    expect(svc.districtRepo.remove).not.toHaveBeenCalled();
  });

  it('filial ko`rsatgan tuman → 400', async () => {
    const { svc } = make({ rows: { branches: [order('7', '173', '3')] } });
    expect(await statusOf(svc.deleteDistrict('173'))).toBe(400);
  });

  it('servis javob bermasa — FAIL-CLOSED 503, o`chirilmaydi', async () => {
    const { svc } = make({ usageDown: true });
    expect(await statusOf(svc.deleteDistrict('173'))).toBe(503);
    expect(svc.districtRepo.remove).not.toHaveBeenCalled();
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- `any` mock'lar (fayldagi naqsh) */
describe('getDistrictUsage — GET /district/:id/usage (Is1zvHN7)', () => {
  it('⭐ tirik buyurtma/foydalanuvchi/filial soni; o‘chirilganlar va boshqa tuman sanalmaydi', async () => {
    const { svc, calls, districts } = make({
      rows: {
        orders: [...fiveInA(), order('16', '173', '3', true)],
        users: [order('301', '173', '3'), order('302', '28', '3')],
        branches: [order('7', '173', '3', true)],
      },
    });
    const res = await svc.getDistrictUsage('173');
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ orders: 5, users: 1, branches: 0 });
    // Faqat sanaydi: hech narsa ko'chmaydi/o'chmaydi.
    expect(calls.map((c) => c.cmd).sort()).toEqual(
      ['branch.geo_usage', 'identity.user.geo_usage', 'order.geo.usage'].sort(),
    );
    expect(calls.every((c) => c.payload.district_id === '173')).toBe(true);
    expect(svc.districtRepo.remove).not.toHaveBeenCalled();
    expect(districts['173']).toBeDefined();
  });

  it('DELETE 400 javobidagi `data.usage` bilan bir xil sonlar', async () => {
    const { svc } = make({
      rows: {
        orders: [order('40', '173', '3'), order('41', '173', '3', true)],
        branches: [order('7', '173', '3')],
      },
    });
    const res = await svc.getDistrictUsage('173');
    const err = await errorOf(svc.deleteDistrict('173'));
    expect(err.statusCode).toBe(400);
    expect(res.data).toEqual({
      orders: err.data.usage.orders,
      users: err.data.usage.users,
      branches: err.data.usage.branches,
    });
  });

  it('bo‘sh tuman — hammasi 0', async () => {
    const { svc } = make();
    expect((await svc.getDistrictUsage('50')).data).toEqual({
      orders: 0,
      users: 0,
      branches: 0,
    });
  });

  it('noma‘lum tuman → 404, servislar so‘ralmaydi', async () => {
    const { svc, calls } = make();
    expect(await statusOf(svc.getDistrictUsage('999'))).toBe(404);
    expect(calls).toEqual([]);
  });

  it('servis javob bermasa — 503 (0 deb ko‘rsatilmaydi)', async () => {
    const { svc } = make({ usageDown: true });
    const err = await errorOf(svc.getDistrictUsage('173'));
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain('sanash to');
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
describe('deleteRegion — himoya (oNAE3LW9)', () => {
  it('⭐ TC3: tumani bor viloyat → 400, tumanlar CASCADE o`chmaydi', async () => {
    const { svc } = make({ regionDistricts: 4 });
    expect(await statusOf(svc.deleteRegion('3'))).toBe(400);
    expect(svc.regionRepo.remove).not.toHaveBeenCalled();
  });

  it('⭐ viloyatga branch_transfer_batches (target_region_id) bog`langan → 400', async () => {
    const { svc } = make({ batches: ['3', '3'] });
    const err = await errorOf(svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("2 ta filiallararo jo'natma");
    expect(svc.regionRepo.remove).not.toHaveBeenCalled();
    const usageCall = svc.orderClient.send.mock.calls.find(
      (c: any[]) => c[0].cmd === 'order.geo.usage',
    );
    expect(usageCall[1]).toEqual({ region_id: '3' });
  });

  it('eski order-service `transfer_batches` qaytarmasa — FAIL-CLOSED 503', async () => {
    const { svc } = make({ legacyOrderUsage: true });
    expect(await statusOf(svc.deleteRegion('3'))).toBe(503);
    expect(svc.regionRepo.remove).not.toHaveBeenCalled();
  });

  it('tumansiz, lekin buyurtma/foydalanuvchi/filial/pochta bog`langan viloyat → 400', async () => {
    for (const opts of [
      { rows: { orders: [order('11', '999', '3')] } },
      { rows: { users: [order('301', '999', '3')] } },
      { rows: { branches: [order('7', '999', '3')] } },
      { posts: 1 },
    ]) {
      const { svc } = make(opts);
      expect(await statusOf(svc.deleteRegion('3'))).toBe(400);
      expect(svc.regionRepo.remove).not.toHaveBeenCalled();
    }
  });

  it('bo`sh viloyat → 200, o`chadi; qidiruvdan asl id bilan', async () => {
    const { svc } = make();
    const res = await svc.deleteRegion('3');
    expect(res.statusCode).toBe(200);
    expect(svc.regionRepo.remove).toHaveBeenCalledTimes(1);
    expect(svc.searchClient.send).toHaveBeenCalledWith(
      { cmd: 'search.index.remove' },
      expect.objectContaining({ type: 'region', sourceId: '3' }),
    );
  });

  /* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- `any` mock'lar (fayldagi naqsh) */
  /**
   * `District.assigned_region` `onDelete: SET NULL`: boshqa viloyatlardan
   * shu viloyatga biriktirilgan tumanlar viloyat o'chsa jimgina o'z geografik
   * viloyatiga qaytardi (HQ intake/jo'natish yo'nalishi o'zgarardi).
   */
  it('⭐ boshqa viloyatlardan 2 ta tuman biriktirilgan → 400 (reason/usage), o`chirilmaydi, servislar so`ralmaydi', async () => {
    const { svc, calls } = make({ assignedDistricts: 2 });
    const err = await errorOf(svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(
      "Bu viloyatga boshqa viloyatlardan 2 ta tuman biriktirilgan, shuning uchun uni o'chirib bo'lmaydi. Avval bu tumanlarni boshqa viloyatga biriktiring.",
    );
    expect(err.data).toEqual({
      reason: 'region_has_assigned_districts',
      usage: { assigned_districts: 2 },
    });
    // Gateway filtridan o'tadi (FE `data.reason`/`data.usage` ni ko'radi).
    expect(publicErrorData(err)).toEqual({
      reason: 'region_has_assigned_districts',
      usage: { assigned_districts: 2 },
    });
    expect(svc.regionRepo.remove).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(svc.postRepo.count).not.toHaveBeenCalled();
    expect(svc.activityLog.log).not.toHaveBeenCalled();
  });

  it('geografik tuman + biriktirilgan tuman — avval geografik sabab (region_has_districts)', async () => {
    const { svc } = make({ regionDistricts: 1, assignedDistricts: 2 });
    const err = await errorOf(svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.data.reason).toBe('region_has_districts');
    expect(svc.regionRepo.remove).not.toHaveBeenCalled();
  });

  it('biriktirilganlar sanog`i: assigned_region = id va region_id != id', async () => {
    const { svc } = make();
    await svc.deleteRegion('3');
    expect(svc.districtRepo.count).toHaveBeenNthCalledWith(1, {
      where: { region_id: '3' },
    });
    expect(svc.districtRepo.count).toHaveBeenNthCalledWith(2, {
      where: { assigned_region: '3', region_id: Not('3') },
    });
  });
  /* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
});

describe('mergeDistricts — birlashtirish (oNAE3LW9 TC5)', () => {
  it('⭐ TC5: A dagi 5 buyurtma B ga ko`chadi, A o`chadi, B jami = eski B + 5', async () => {
    const { svc, districts, inDistrict, calls } = make({
      rows: {
        orders: fiveInA(),
        users: [order('301', '173', '3')],
        branches: [order('7', '173', '3')],
      },
    });
    const res = await svc.mergeDistricts('173', '28');
    expect(res.statusCode).toBe(200);
    expect(res.data.moved).toEqual({ orders: 5, users: 1, branches: 1 });
    expect(res.data.target_before.orders).toBe(3);
    expect(res.data.target_after.orders).toBe(8);
    expect(inDistrict('orders', '28')).toHaveLength(8);
    expect(inDistrict('orders', '173')).toHaveLength(0);
    expect(districts['173']).toBeUndefined();
    expect(districts['28']).toBeDefined();
    // ketma-ket: buyurtma → foydalanuvchi → filial; B viloyati + muddat bilan.
    const moves = calls.filter((c) => c.cmd.endsWith('reassign_district'));
    expect(moves.map((c) => c.cmd)).toEqual([
      'order.geo.reassign_district',
      'identity.user.reassign_district',
      'branch.reassign_district',
    ]);
    expect(moves[0].payload).toEqual({
      from_district_id: '173',
      to_district_id: '28',
      to_region_id: '3',
      deadline_at: expect.any(Number),
    });
    expect(svc.searchClient.send).toHaveBeenCalledWith(
      { cmd: 'search.index.remove' },
      expect.objectContaining({ type: 'district', sourceId: '173' }),
    );
    // (ILq3WNL1) alohida amal — oddiy `deleted` emas.
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '173',
        action: 'district.merge',
        new_value: { merged_into: '28' },
      }),
    );
  });

  it('⭐ o`rtadagi bosqich (identity) rad etsa — buyurtmalar AYNAN o`sha ID lar bo`yicha A ga qaytadi, A qoladi, 409', async () => {
    const { svc, rows, districts, inDistrict, calls } = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 400 } },
    });
    const err = await errorOf(svc.mergeDistricts('173', '28'));
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('qaytarildi');
    expect(inDistrict('orders', '173').sort()).toEqual([
      '11',
      '12',
      '13',
      '14',
      '15',
    ]);
    // B ning O'Z buyurtmalari joyida (faqat ko'chirilganlar qaytdi).
    expect(inDistrict('orders', '28').sort()).toEqual(['91', '92', '93']);
    // region_id ham aynan tiklandi (null ham).
    expect(rows.orders.find((r) => r.id === '15')?.region_id).toBeNull();
    expect(districts['173']).toBeDefined();
    const back = calls.find(
      (c) =>
        c.cmd === 'order.geo.reassign_district' && Array.isArray(c.payload.ids),
    );
    expect(back?.payload).toEqual(
      expect.objectContaining({
        from_district_id: '28',
        to_district_id: '173',
        ids: ['11', '12', '13', '14', '15'],
      }),
    );
    expect(calls.some((c) => c.cmd === 'branch.reassign_district')).toBe(false);
    expect(svc.logger.error).not.toHaveBeenCalled();
  });

  it('boshqa viloyatdagi B ga: yiqilganda region_id lar ham eski holiga qaytadi', async () => {
    const { svc, rows } = make({
      rows: { orders: fiveInA() },
      forwardFault: { branches: { statusCode: 409 } },
    });
    expect(await statusOf(svc.mergeDistricts('173', '50'))).toBe(409);
    const byId = Object.fromEntries(
      rows.orders.map((r) => [r.id, [r.district_id, r.region_id]]),
    );
    expect(byId['11']).toEqual(['173', '3']);
    expect(byId['15']).toEqual(['173', null]);
  });

  it('oxirgi bosqich (branch) javob bermasa — oldingi ikkalasi teskari tartibda qaytadi, 503', async () => {
    const { svc, inDistrict, districts, calls } = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { branches: 'timeout' },
    });
    expect(await statusOf(svc.mergeDistricts('173', '28'))).toBe(503);
    expect(inDistrict('orders', '173')).toHaveLength(5);
    expect(inDistrict('users', '173')).toEqual(['301']);
    expect(districts['173']).toBeDefined();
    const compensations = calls
      .filter((c) => Array.isArray(c.payload?.ids))
      .map((c) => c.cmd);
    expect(compensations).toEqual([
      'identity.user.reassign_district',
      'order.geo.reassign_district',
    ]);
  });

  it('⭐ B jami mos kelmasa (parallel yozuv) — 409, ko`chirilganlar qaytadi, A o`chirilmaydi', async () => {
    const { svc, districts, inDistrict } = make({
      rows: { orders: fiveInA() },
      afterForward: (kind, rows) => {
        if (kind === 'orders') rows.orders.push(order('99', '28', '3'));
      },
    });
    const err = await errorOf(svc.mergeDistricts('173', '28'));
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('kutilgan 3 + 5 = 8');
    expect(districts['173']).toBeDefined(); // tranzaksiya rollback
    expect(inDistrict('orders', '173')).toHaveLength(5);
    expect(inDistrict('orders', '28').sort()).toEqual(['91', '92', '93', '99']);
  });

  it('ko`chirishdan keyin A da qoldiq bo`lsa — 409, A o`chirilMAYDI, ko`chirilganlar qaytadi', async () => {
    const { svc, districts, inDistrict } = make({
      rows: { orders: fiveInA() },
      afterForward: (kind, rows) => {
        if (kind === 'orders') rows.orders.push(order('16', '173', '3'));
      },
    });
    const err = await errorOf(svc.mergeDistricts('173', '28'));
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('A tumanda hali 1 ta buyurtma qoldi');
    expect(districts['173']).toBeDefined();
    expect(inDistrict('orders', '173')).toHaveLength(6);
  });

  it('A ni o`chirish yiqilsa — 503, ko`chirilganlar qaytadi', async () => {
    const { svc, districts, inDistrict } = make({
      rows: { orders: fiveInA() },
      removeFails: true,
    });
    expect(await statusOf(svc.mergeDistricts('173', '28'))).toBe(503);
    expect(districts['173']).toBeDefined();
    expect(inDistrict('orders', '173')).toHaveLength(5);
  });

  it('⭐ kompensatsiyaning o`zi yiqilsa — ERROR log + activity log da ID lar va xato javobida ko`rsatiladi', async () => {
    const { svc, districts, inDistrict } = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 409 } },
      compensateFault: { orders: 'timeout' },
    });
    const err = await errorOf(svc.mergeDistricts('173', '28'));
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("QO'LDA TUZATING");
    expect(err.message).toContain('B tumanda (#28) qoldi');
    expect(err.message).toContain('11, 12, 13, 14, 15');
    expect(err.data.stranded).toEqual([
      expect.objectContaining({
        kind: 'orders',
        district_id: '28',
        ids: ['11', '12', '13', '14', '15'],
      }),
    ]);
    expect(svc.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("KOMPENSATSIYA TO'LIQ EMAS"),
    );
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'District',
        entity_id: '173',
        action: 'district.merge_compensation_failed',
        metadata: expect.objectContaining({
          stranded: [
            expect.objectContaining({
              district_id: '28',
              ids: ['11', '12', '13', '14', '15'],
            }),
          ],
        }),
      }),
    );
    expect(districts['173']).toBeDefined();
    expect(inDistrict('orders', '28')).toHaveLength(8); // haqiqatan B da qoldi
  });

  it('javobi kelmagan bosqich ko`chirib ulgurgan bo`lsa — "ID lar noma`lum" deb qo`lda tuzatishga yoziladi', async () => {
    const { svc } = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: 'timeout_after_move' },
    });
    const err = await errorOf(svc.mergeDistricts('173', '28'));
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("ID'lar noma'lum");
    expect(err.data.stranded).toEqual([
      expect.objectContaining({ kind: 'users', ids: null }),
    ]);
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'district.merge_compensation_failed' }),
    );
  });

  it('javobi kelmagan bosqich ko`chirmagan bo`lsa — oddiy bekor qilish (503, qo`lda tuzatish yo`q)', async () => {
    const { svc } = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: 'timeout' },
    });
    const err = await errorOf(svc.mergeDistricts('173', '28'));
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain('qaytarildi');
    expect(svc.activityLog.log).not.toHaveBeenCalled();
  });

  it('o`ziga birlashtirish → 400; noma`lum B → 404', async () => {
    const { svc } = make();
    expect(await statusOf(svc.mergeDistricts('173', '173'))).toBe(400);
    expect(await statusOf(svc.mergeDistricts('173', '999'))).toBe(404);
  });
});

/**
 * tf324cXN — birlashtirish xatosida mashina o'qiydigan sabab: `data.reason`
 * va `data.details` (reason, kind, mismatches, timeout_ms). Mavjud kalitlar
 * (`rolled_back`, `stranded`, xabar) o'zgarmaydi; gateway `publicErrorData`
 * shuni FE'ga o'tkazadi.
 */
type MergeErrorData = {
  reason: string;
  details: Record<string, unknown>;
  rolled_back?: Record<string, number>;
  from_district_id?: string;
  stranded?: Array<{ ids: string[] | null }>;
};
type MergeError = { statusCode: number; message: string; data: MergeErrorData };
type Harness = ReturnType<typeof make>;
type GeoSend = (
  pattern: { cmd: string },
  payload: { ids?: unknown },
) => unknown;
const mergeError = async (h: Harness, to = '28'): Promise<MergeError> =>
  (await errorOf(
    (h.svc as LogisticsServiceService).mergeDistricts('173', to),
  )) as MergeError;
const activityLogOf = (h: Harness) =>
  (h.svc as { activityLog: { log: jest.Mock } }).activityLog.log;

describe('mergeDistricts — xato sababi (tf324cXN)', () => {
  it('⭐ servis rad etsa — remote_refused, kind = qadam; eski kalitlar joyida', async () => {
    const h = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 400 } },
    });
    const err = await mergeError(h);
    expect(err.statusCode).toBe(409);
    expect(err.data.reason).toBe('remote_refused');
    expect(err.data.details).toEqual({
      reason: 'remote_refused',
      kind: 'users',
      from_district_id: '173',
      to_district_id: '28',
      // (Z1c1sNPT) qaytarilgan sonlar — tekis.
      rolled_back_orders: 5,
      rolled_back_users: 0,
      rolled_back_branches: 0,
      manual_fix: false,
    });
    expect(err.data.rolled_back).toEqual({ orders: 5 });
    expect(err.data.from_district_id).toBe('173');
    expect(err.message).toContain('qaytarildi');
    // Gateway filtridan o'tgan holat.
    expect(publicErrorData(err)).toEqual({
      reason: 'remote_refused',
      details: err.data.details,
    });
  });

  it('⭐ javob kelmasa — timeout, details.timeout_ms = 15000', async () => {
    const h = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: 'timeout' },
    });
    const err = await mergeError(h);
    expect(err.statusCode).toBe(503);
    expect(err.data.reason).toBe('timeout');
    expect(err.data.details).toEqual(
      expect.objectContaining({
        reason: 'timeout',
        kind: 'users',
        timeout_ms: 15000,
      }),
    );
  });

  it('⭐ servis javobi noto‘g‘ri — invalid_response', async () => {
    const h = make({ rows: { orders: fiveInA() } });
    const client = (h.svc as { branchClient: { send: GeoSend } }).branchClient;
    const send = client.send;
    client.send = jest.fn((pattern, payload) =>
      pattern.cmd === 'branch.reassign_district' && !Array.isArray(payload.ids)
        ? of({ statusCode: 200, data: { moved: 0 } })
        : send(pattern, payload),
    );
    const err = await mergeError(h);
    expect(err.statusCode).toBe(503);
    expect(err.data.reason).toBe('invalid_response');
    expect(err.data.details).toEqual(
      expect.objectContaining({ reason: 'invalid_response', kind: 'branches' }),
    );
  });

  it('⭐ B jami mos kelmasa — count_mismatch, mismatches: target expected/actual; matn shundan', async () => {
    const h = make({
      rows: { orders: fiveInA() },
      afterForward: (kind, rows) => {
        if (kind === 'orders') rows.orders.push(order('99', '28', '3'));
      },
    });
    const err = await mergeError(h);
    const mismatches = [
      { kind: 'orders', district: 'target', expected: 8, actual: 9 },
    ];
    expect(err.statusCode).toBe(409);
    expect(err.data.reason).toBe('count_mismatch');
    expect(err.data.details).toEqual(
      expect.objectContaining({
        reason: 'count_mismatch',
        kind: 'orders',
        mismatches,
      }),
    );
    expect(err.message).toContain('soni 9, kutilgan 3 + 5 = 8');
    expect(publicErrorData(err)?.details).toEqual(
      expect.objectContaining({ mismatches }),
    );
  });

  it('A da qoldiq — count_mismatch, mismatches: source expected 0', async () => {
    const h = make({
      rows: { orders: fiveInA() },
      afterForward: (kind, rows) => {
        if (kind === 'orders') rows.orders.push(order('16', '173', '3'));
      },
    });
    const err = await mergeError(h);
    expect(err.data.details.mismatches).toEqual([
      { kind: 'orders', district: 'source', expected: 0, actual: 1 },
    ]);
  });

  it('A ni o‘chirish yiqilsa — delete_failed, kind null', async () => {
    const h = make({ rows: { orders: fiveInA() }, removeFails: true });
    const err = await mergeError(h);
    expect(err.statusCode).toBe(503);
    expect(err.data.reason).toBe('delete_failed');
    expect(err.data.details).toEqual(
      expect.objectContaining({ reason: 'delete_failed', kind: null }),
    );
  });

  it('kompensatsiya chala — sabab saqlanadi, manual_fix + stranded (ID’siz) details da; eski stranded o‘zgarmaydi', async () => {
    const h = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 409 } },
      compensateFault: { orders: 'timeout' },
    });
    const err = await mergeError(h);
    expect(err.data.reason).toBe('remote_refused');
    expect(err.data.details).toEqual(
      expect.objectContaining({
        reason: 'remote_refused',
        kind: 'users',
        manual_fix: true,
        stranded: [{ kind: 'orders', district_id: '28', count: 5 }],
      }),
    );
    expect(err.data.stranded?.[0].ids).toEqual(['11', '12', '13', '14', '15']);
    const [entry] = activityLogOf(h).mock.calls[0] as [
      { action: string; metadata: { reason_code: string } },
    ];
    expect(entry.action).toBe('district.merge_compensation_failed');
    expect(entry.metadata.reason_code).toBe('remote_refused');
  });
});

/**
 * Z1c1sNPT — «A ga qaytarildi: buyurtmalar N · foydalanuvchilar N · filiallar
 * N» ro'yxati uchun sonlar `data.details` ichida TEKIS maydonlar:
 * `rolled_back_orders`, `rolled_back_users`, `rolled_back_branches` (uchala
 * tur doim, boshlanmagan qadam — 0). Ildizdagi `rolled_back` ichma-ich obyekt
 * — gateway `publicErrorData` uni o'tkazmaydi (orqaga moslik uchun joyida).
 * Ixtiyoriy qism: qaytmagan buyurtmalarning birinchi ≤10 ta ID'si —
 * `details.stranded_order_ids`.
 */
describe('mergeDistricts — qaytarilgan sonlar data.details da (Z1c1sNPT)', () => {
  const rolledBackOf = (details: Record<string, unknown> | undefined) => ({
    orders: details?.rolled_back_orders,
    users: details?.rolled_back_users,
    branches: details?.rolled_back_branches,
  });

  it('⭐ ikkinchi qadam rad etsa — buyurtmalar 5, foydalanuvchilar 0, filiallar 0; gateway filtridan o‘tadi', async () => {
    const h = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 400 } },
    });
    const err = await mergeError(h);
    expect(err.statusCode).toBe(409);
    expect(rolledBackOf(err.data.details)).toEqual({
      orders: 5,
      users: 0,
      branches: 0,
    });
    // Eski ildiz kaliti o'zgarmadi.
    expect(err.data.rolled_back).toEqual({ orders: 5 });
    const pub = publicErrorData(err);
    expect(rolledBackOf(pub?.details as Record<string, unknown>)).toEqual({
      orders: 5,
      users: 0,
      branches: 0,
    });
    // Ildizdagi `rolled_back` (ichma-ich) FE'ga chiqmaydi — shuning uchun tekis.
    expect(pub).not.toHaveProperty('rolled_back');
    expect(pub?.details).not.toHaveProperty('stranded_order_ids');
  });

  it('⭐ oxirgi qadam javob bermasa (503) — buyurtmalar 5, foydalanuvchilar 1, filiallar 0', async () => {
    const h = make({
      rows: {
        orders: fiveInA(),
        users: [order('301', '173', '3')],
        branches: [order('7', '173', '3')],
      },
      forwardFault: { branches: 'timeout' },
    });
    const err = await mergeError(h);
    expect(err.statusCode).toBe(503);
    expect(err.data.details.reason).toBe('timeout');
    expect(
      rolledBackOf(publicErrorData(err)?.details as Record<string, unknown>),
    ).toEqual({
      orders: 5,
      users: 1,
      branches: 0,
    });
  });

  it('⭐ uchala qadam o‘tib tekshiruv mos kelmasa — hammasi qaytariladi: 5 · 1 · 1', async () => {
    const h = make({
      rows: {
        orders: fiveInA(),
        users: [order('301', '173', '3')],
        branches: [order('7', '173', '3')],
      },
      afterForward: (kind, rows) => {
        if (kind === 'orders') rows.orders.push(order('99', '28', '3'));
      },
    });
    const err = await mergeError(h);
    expect(err.statusCode).toBe(409);
    expect(err.data.reason).toBe('count_mismatch');
    expect(rolledBackOf(err.data.details)).toEqual({
      orders: 5,
      users: 1,
      branches: 1,
    });
    expect(err.data.details.manual_fix).toBe(false);
  });

  it('A ni o‘chirish yiqilsa — delete_failed bilan ham sonlar bor', async () => {
    const h = make({ rows: { orders: fiveInA() }, removeFails: true });
    const err = await mergeError(h);
    expect(err.data.reason).toBe('delete_failed');
    expect(rolledBackOf(err.data.details)).toEqual({
      orders: 5,
      users: 0,
      branches: 0,
    });
  });

  it('⭐ kompensatsiya chala — qaytmaganlar sanalmaydi (0), stranded_order_ids da ID’lar', async () => {
    const h = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 409 } },
      compensateFault: { orders: 'timeout' },
    });
    const err = await mergeError(h);
    expect(err.data.details.manual_fix).toBe(true);
    expect(rolledBackOf(err.data.details)).toEqual({
      orders: 0,
      users: 0,
      branches: 0,
    });
    expect(err.data.details.stranded_order_ids).toEqual([
      '11',
      '12',
      '13',
      '14',
      '15',
    ]);
    expect(publicErrorData(err)?.details).toEqual(
      expect.objectContaining({
        rolled_back_orders: 0,
        stranded_order_ids: ['11', '12', '13', '14', '15'],
      }),
    );
  });

  it('qisman qaytsa — qaytgani sanaladi (4), qaytmagani stranded_order_ids da', async () => {
    const h = make({
      rows: { orders: fiveInA() },
      // Ko'chgandan keyin #15 B dan boshqa tumanga o'tib ketdi: tekshiruv mos
      // kelmaydi, kompensatsiya uni B da topmaydi.
      afterForward: (kind, rows) => {
        if (kind !== 'orders') return;
        const row = rows.orders.find((r) => r.id === '15');
        if (row) row.district_id = '50';
      },
    });
    const err = await mergeError(h);
    expect(err.data.details.manual_fix).toBe(true);
    expect(err.data.details.rolled_back_orders).toBe(4);
    expect(err.data.details.stranded_order_ids).toEqual(['15']);
    expect(err.data.rolled_back).toEqual({ orders: 4, users: 0, branches: 0 });
  });

  it('stranded_order_ids — birinchi 10 tasi (to‘liq ro‘yxat activity log da)', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      order(String(1001 + i), '173', '3'),
    );
    const h = make({
      rows: { orders: many, users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 409 } },
      compensateFault: { orders: { statusCode: 500 } },
    });
    const err = await mergeError(h);
    const ids = err.data.details.stranded_order_ids as string[];
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('1001');
    expect(ids[9]).toBe('1010');
    const [entry] = activityLogOf(h).mock.calls[0] as [
      { metadata: { stranded: Array<{ ids: string[] }> } },
    ];
    expect(entry.metadata.stranded[0].ids).toHaveLength(12);
  });

  it('faqat ID’si noma’lum (javobi kelmagan) qadam qolsa — stranded_order_ids yo‘q', async () => {
    const h = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: 'timeout_after_move' },
    });
    const err = await mergeError(h);
    expect(err.data.details.manual_fix).toBe(true);
    expect(err.data.details).not.toHaveProperty('stranded_order_ids');
    expect(rolledBackOf(err.data.details)).toEqual({
      orders: 5,
      users: 0,
      branches: 0,
    });
  });
});

type MergeOk = {
  statusCode: number;
  data: {
    moved: Record<string, number>;
    moved_live: Record<string, number>;
  };
};
const mergeOk = async (h: Harness): Promise<MergeOk> =>
  (await (h.svc as LogisticsServiceService).mergeDistricts(
    '173',
    '28',
  )) as MergeOk;
const withDeletedInA = () => ({
  orders: [
    order('11', '173', '3'),
    order('12', '173', '3'),
    order('13', '173', '3', true),
    order('91', '28', '3'),
  ],
  users: [order('301', '173', '3', true)],
  branches: [order('7', '173', '3')],
});

/**
 * vsmpTweI — natija oynasidagi «Ko'chirildi» faqat TIRIK yozuvlar:
 * `moved_live` ko'chirish qadamining o'zidan (servis `moved_live`), `moved`
 * esa avvalgidek jami (o'chirilganlar bilan).
 */
describe('mergeDistricts — moved_live (vsmpTweI)', () => {
  it('⭐ o‘chirilganlar `moved` da bor, `moved_live` da yo‘q; activity metadata da ham', async () => {
    const h = make({ rows: withDeletedInA() });
    const res = await mergeOk(h);
    expect(res.statusCode).toBe(200);
    expect(res.data.moved).toEqual({ orders: 3, users: 1, branches: 1 });
    expect(res.data.moved_live).toEqual({ orders: 2, users: 0, branches: 1 });
    const [entry] = activityLogOf(h).mock.calls[0] as [
      { metadata: { moved_live: Record<string, number> } },
    ];
    expect(entry.metadata.moved_live).toEqual({
      orders: 2,
      users: 0,
      branches: 1,
    });
  });

  it('eski servis `moved_live` qaytarmasa — ko‘chgan va A dagi oldingi tirik sonning kichigi', async () => {
    const h = make({ rows: withDeletedInA(), legacyMovedLive: true });
    const res = await mergeOk(h);
    expect(res.data.moved_live).toEqual({ orders: 2, users: 0, branches: 1 });
  });
});

/**
 * ILq3WNL1 — faoliyat jurnali: muvaffaqiyatli birlashtirish `district.merge`
 * («Tuman birlashtirildi»), chala qolgani `district.merge_compensation_failed`
 * («Tuman birlashtirish chala qoldi»).
 */
describe('mergeDistricts — jurnal amali (ILq3WNL1)', () => {
  type LogEntry = {
    entity_type: string;
    entity_id: string;
    action: string;
    description: string;
    old_value: Record<string, unknown>;
    new_value: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };

  it('⭐ muvaffaqiyat — district.merge: tavsif, old_value snapshot, new_value.merged_into, metadata sonlari', async () => {
    const h = make({ rows: withDeletedInA() });
    await mergeOk(h);
    const log = activityLogOf(h);
    expect(log).toHaveBeenCalledTimes(1);
    const [entry] = log.mock.calls[0] as [LogEntry];
    expect(entry.entity_type).toBe('District');
    expect(entry.entity_id).toBe('173');
    expect(entry.action).toBe('district.merge');
    expect(entry.description).toBe(
      'Tuman birlashtirildi: Andijon shahri (#173) → Andijon (#28)',
    );
    expect(entry.old_value).toEqual({
      name: 'Andijon shahri',
      sato_code: '1',
      region_id: '3',
    });
    expect(entry.new_value).toEqual({ merged_into: '28' });
    expect(Object.keys(entry.metadata).sort()).toEqual([
      'moved',
      'moved_live',
      'source_before',
      'target_after',
      'target_before',
    ]);
    expect(ACTIVITY_ACTION_REGISTRY['district.merge']).toEqual(
      expect.objectContaining({
        label: 'Tuman birlashtirildi',
        category: 'logistics',
      }),
    );
  });

  it('chala qolgan — district.merge_compensation_failed «Tuman birlashtirish chala qoldi»', async () => {
    const h = make({
      rows: { orders: fiveInA(), users: [order('301', '173', '3')] },
      forwardFault: { users: { statusCode: 409 } },
      compensateFault: { orders: 'timeout' },
    });
    await mergeError(h);
    const [entry] = activityLogOf(h).mock.calls[0] as [LogEntry];
    expect(entry.action).toBe('district.merge_compensation_failed');
    expect(entry.description).toBe(
      'Tuman birlashtirish chala qoldi: #173 → #28',
    );
    expect(
      ACTIVITY_ACTION_REGISTRY['district.merge_compensation_failed'].label,
    ).toBe('Tuman birlashtirish chala qoldi');
  });
});

/**
 * oNAE3LW9 (merge-message) — 2026-10-09 prod UI testi: buyurtmasi bor tumanni
 * o'chirishda frontend backend matnini to'g'ridan-to'g'ri ko'rsatdi va unda
 * xom API yo'li bor edi: "... birlashtiring (POST /district/187/merge) ...".
 * Matn faqat o'zbekcha tushuntirish bo'lishi, endpoint esa mashina uchun
 * alohida `data.hint` maydonida berilishi kerak. Maslahat faqat BAJARSA
 * BO'LADIGAN amalni taklif qiladi.
 */
describe('o`chirish xabarlari — foydalanuvchiga tushunarli (oNAE3LW9 merge-message)', () => {
  /** Matnda HTTP metod + yo'l ("POST /district/...") bo'lmasligi kerak. */
  const RAW_API = /\b(GET|POST|PATCH|PUT|DELETE)\s+\/|\/district\/|\/merge\b/;

  it('⭐ tuman: matnda API yo`li yo`q, sonlar saqlangan, endpoint `data.hint` da', async () => {
    // Prod holati: 1 ta buyurtma + 1 ta mijoz (tuman #187 o'rniga #173).
    const { svc } = make({
      rows: {
        orders: [order('40', '173', '3')],
        users: [order('41', '173', '3')],
      },
    });
    const err = await errorOf(svc.deleteDistrict('173'));
    expect(err.statusCode).toBe(400);
    expect(err.message).not.toMatch(RAW_API);
    // "ularni" emas — nimani ko'chirish kerakligi aniq aytiladi.
    expect(err.message).toBe(
      "Bu tumanda 1 ta buyurtma, 1 ta foydalanuvchi (mijoz/kuryer/market) bor, shuning uchun uni o'chirib bo'lmaydi. " +
        "Avval tumanlarni birlashtiring (bu tumanni boshqa tumanga qo'shing) yoki buyurtma va foydalanuvchilarni boshqa tumanga ko'chiring.",
    );
    expect(err.message).not.toContain('ularni');
    expect(err.data).toEqual({
      reason: 'district_in_use',
      usage: { orders: 1, users: 1, branches: 0, transfer_batches: 0 },
      hint: { action: 'merge', method: 'POST', path: '/district/173/merge' },
    });
    expect(svc.districtRepo.remove).not.toHaveBeenCalled();
  });

  it('tuman: faqat filial bog`langan bo`lsa ham matn toza, son va ko`chiriladigan tur aytiladi', async () => {
    const { svc } = make({ rows: { branches: [order('7', '173', '3')] } });
    const err = await errorOf(svc.deleteDistrict('173'));
    expect(err.message).not.toMatch(RAW_API);
    expect(err.message).toContain('Bu tumanda 1 ta filial bor');
    expect(err.message).toContain('Avval tumanlarni birlashtiring');
    expect(err.message).toContain(
      "yoki filiallarni boshqa tumanga ko'chiring.",
    );
    expect(err.data.usage.branches).toBe(1);
  });

  it('tuman: uchala tur — "buyurtma, foydalanuvchi va filiallarni"', async () => {
    const { svc } = make({
      rows: {
        orders: [order('40', '173', '3')],
        users: [order('41', '173', '3')],
        branches: [order('7', '173', '3')],
      },
    });
    const err = await errorOf(svc.deleteDistrict('173'));
    expect(err.message).toContain(
      "yoki buyurtma, foydalanuvchi va filiallarni boshqa tumanga ko'chiring.",
    );
  });

  it('⭐ viloyat: tumani bor — bajarsa bo`ladigan yo`l (o`chirish / boshqa viloyatdagi tumanga birlashtirish)', async () => {
    const { svc } = make({ regionDistricts: 4 });
    const err = await errorOf(svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.message).not.toMatch(RAW_API);
    // `district.region_id` ni o'zgartiradigan API yo'q (PATCH district faqat
    // `assigned_region`) — "boshqa viloyatga ko'chiring" bajarib bo'lmaydi.
    expect(err.message).not.toContain("ko'chiring");
    expect(err.message).toBe(
      "Bu viloyatda 4 ta tuman bor, shuning uchun uni o'chirib bo'lmaydi. Avval tumanlarni o'chiring yoki boshqa viloyatdagi tumanga birlashtiring.",
    );
    expect(err.data).toEqual({ reason: 'region_has_districts', districts: 4 });
  });

  it('viloyat: maslahat haqiqatan bajariladi — boshqa viloyatdagi tumanga birlashtirilgan tuman o`chadi', async () => {
    // #173 (viloyat 3) → #50 (viloyat 9): birlashtirish boshqa viloyatga
    // ruxsat etiladi, A tuman o'chadi va buyurtmalar B viloyatiga o'tadi.
    const { svc, districts, rows } = make({
      rows: { orders: [order('40', '173', '3')] },
    });
    const res = await svc.mergeDistricts('173', '50');
    expect(res.statusCode).toBe(200);
    expect(districts['173']).toBeUndefined();
    expect(rows.orders[0]).toMatchObject({ district_id: '50', region_id: '9' });
  });

  it('viloyat: faqat ko`chirsa bo`ladigan yozuvlar — sonlar saqlangan, aniq maslahat', async () => {
    const { svc } = make({
      rows: {
        orders: [order('11', '999', '3')],
        users: [order('301', '999', '3')],
      },
    });
    const err = await errorOf(svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.message).not.toMatch(RAW_API);
    expect(err.message).toBe(
      "Bu viloyatga 1 ta buyurtma, 1 ta foydalanuvchi (mijoz/kuryer/market) bog'langan, shuning uchun uni o'chirib bo'lmaydi. Avval buyurtma va foydalanuvchilarni boshqa viloyatga ko'chiring.",
    );
    expect(err.data).toEqual({
      reason: 'region_in_use',
      usage: {
        orders: 1,
        users: 1,
        branches: 0,
        transfer_batches: 0,
        posts: 0,
      },
    });
  });

  it('⭐ viloyat: pochta/jo`natma (tarixiy) bog`langan — "ko`chiring" taklif qilinmaydi', async () => {
    const { svc } = make({
      rows: { orders: [order('11', '999', '3')] },
      posts: 2,
    });
    const err = await errorOf(svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.message).not.toMatch(RAW_API);
    expect(err.message).not.toContain("ko'chiring");
    expect(err.message).toBe(
      "Bu viloyatga 1 ta buyurtma, 2 ta pochta bog'langan, shuning uchun uni o'chirib bo'lmaydi. Pochtalar tarixiy yozuv bo'lgani uchun ularni boshqa viloyatga ko'chirib bo'lmaydi.",
    );
    expect(err.data).toEqual({
      reason: 'region_in_use',
      usage: {
        orders: 1,
        users: 0,
        branches: 0,
        transfer_batches: 0,
        posts: 2,
      },
    });
  });

  it('viloyat: pochta + filiallararo jo`natma — ikkalasi nomlanadi, "ko`chiring" yo`q', async () => {
    const { svc } = make({ posts: 1, batches: ['3'] });
    const err = await errorOf(svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.message).not.toContain("ko'chiring");
    expect(err.message).toContain(
      "Pochta va filiallararo jo'natmalar tarixiy yozuv bo'lgani uchun ularni boshqa viloyatga ko'chirib bo'lmaydi.",
    );
  });
});

/**
 * oNAE3LW9 (2026-10-09 prod, 2-tur): tuman himoyasi O'CHIRILGAN (soft-delete)
 * buyurtmalarni ham sanardi — TEST buyurtma o'chirilgandan keyin ham tuman
 * "1 ta buyurtma bor" deb 400 qaytarardi, foydalanuvchi esa tumanda hech
 * narsa ko'rmaydi (o'chirilgan buyurtma 404, uni ko'chirib bo'lmaydi).
 * Endi himoya faqat tirik yozuvlarga qaraydi; birlashtirish esa o'chirilganlarni
 * ham ko'chiradi va jami bo'yicha tekshiradi (A da hech narsa qolmaydi).
 */
describe('o`chirilgan (soft-delete) yozuvlar — himoya va birlashtirish (oNAE3LW9 prod 2-tur)', () => {
  it('⭐ o`chirilgan buyurtma bor, tirik yo`q → o`chirish 200; activity log da deleted_refs', async () => {
    const { svc, districts } = make({
      rows: { orders: [order('40', '173', '3', true)] },
    });
    const res = await svc.deleteDistrict('173');
    expect(res.statusCode).toBe(200);
    expect(districts['173']).toBeUndefined();
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'District',
        entity_id: '173',
        action: 'deleted',
        old_value: expect.objectContaining({ name: 'Andijon shahri' }),
        metadata: {
          region_id: '3',
          deleted_refs: {
            orders: 1,
            users: 0,
            branches: 0,
            transfer_batches: 0,
          },
        },
      }),
    );
  });

  it('⭐ tirik buyurtma bor → 400 (avvalgidek); xabar va `usage` faqat tiriklarni sanaydi', async () => {
    const { svc, districts } = make({
      rows: {
        orders: [order('40', '173', '3'), order('41', '173', '3', true)],
      },
    });
    const err = await errorOf(svc.deleteDistrict('173'));
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('Bu tumanda 1 ta buyurtma bor');
    expect(err.data.usage).toEqual({
      orders: 1,
      users: 0,
      branches: 0,
      transfer_batches: 0,
    });
    expect(districts['173']).toBeDefined();
  });

  it('faqat o`chirilgan foydalanuvchi/filial — o`chirish 200', async () => {
    const { svc, districts } = make({
      rows: {
        users: [order('301', '173', '3', true)],
        branches: [order('7', '173', '3', true)],
      },
    });
    expect((await svc.deleteDistrict('173')).statusCode).toBe(200);
    expect(districts['173']).toBeUndefined();
  });

  it('tirik buyurtmasi yo`q tuman: o`chirilganlari bo`lmasa activity log da deleted_refs yo`q', async () => {
    const { svc } = make();
    await svc.deleteDistrict('173');
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { region_id: '3' } }),
    );
  });

  it('viloyat: faqat o`chirilgan buyurtma/foydalanuvchi/filial/jo`natma → 200; tirik bo`lsa 400', async () => {
    const deletedOnly = make({
      rows: {
        orders: [order('11', '999', '3', true)],
        users: [order('301', '999', '3', true)],
        branches: [order('7', '999', '3', true)],
      },
      deletedBatches: ['3'],
    });
    const res = await deletedOnly.svc.deleteRegion('3');
    expect(res.statusCode).toBe(200);
    expect(deletedOnly.svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Region',
        metadata: {
          deleted_refs: {
            orders: 1,
            users: 1,
            branches: 1,
            transfer_batches: 1,
          },
        },
      }),
    );

    const live = make({
      rows: {
        orders: [order('11', '999', '3'), order('12', '999', '3', true)],
      },
    });
    const err = await errorOf(live.svc.deleteRegion('3'));
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("Bu viloyatga 1 ta buyurtma bog'langan");
    expect(live.svc.regionRepo.remove).not.toHaveBeenCalled();
  });

  it('⭐ birlashtirish: o`chirilgan buyurtmalar ham B ga ko`chadi, A da hech narsa qolmaydi, tekshiruv jami bo`yicha', async () => {
    const { svc, districts, inDistrict } = make({
      rows: {
        orders: [
          order('11', '173', '3'),
          order('12', '173', '3'),
          order('13', '173', '3', true),
          order('91', '28', '3'),
          order('92', '28', '3', true),
        ],
        users: [order('301', '173', '3', true)],
      },
    });
    const res = await svc.mergeDistricts('173', '28');
    expect(res.statusCode).toBe(200);
    expect(res.data.moved).toEqual({ orders: 3, users: 1, branches: 0 });
    expect(inDistrict('orders', '173')).toEqual([]);
    expect(inDistrict('users', '173')).toEqual([]);
    expect(inDistrict('orders', '28').sort()).toEqual([
      '11',
      '12',
      '13',
      '91',
      '92',
    ]);
    // tiriklar: 1 + 2 = 3; o'chirilganlar: 1 + 1 = 2
    expect(res.data.target_before).toEqual(
      expect.objectContaining({
        orders: 1,
        deleted: expect.objectContaining({ orders: 1 }),
      }),
    );
    expect(res.data.target_after).toEqual(
      expect.objectContaining({
        orders: 3,
        users: 0,
        deleted: expect.objectContaining({ orders: 2, users: 1 }),
      }),
    );
    expect(districts['173']).toBeUndefined();
  });

  it('⭐ birlashtirishdan keyin A da o`chirilgan buyurtma qolsa — 409, A o`chirilMAYDI (yetim qolmasin)', async () => {
    const { svc, districts, inDistrict } = make({
      rows: { orders: [order('11', '173', '3')] },
      afterForward: (kind, rows) => {
        // masalan, o'chirilganlarni ko'chirmaydigan eski order-service
        if (kind === 'orders') rows.orders.push(order('16', '173', '3', true));
      },
    });
    const err = await errorOf(svc.mergeDistricts('173', '28'));
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain(
      "A tumanda hali 1 ta buyurtma qoldi (shundan 1 tasi o'chirilgan)",
    );
    expect(districts['173']).toBeDefined();
    expect(inDistrict('orders', '173').sort()).toEqual(['11', '16']);
  });

  it('eski servislar (`deleted_*` yo`q, o`chirilganlarni asosiy maydonda sanaydi): himoya qattiqroq (400), birlashtirish baribir to`g`ri', async () => {
    const guard = make({
      rows: { orders: [order('40', '173', '3', true)] },
      legacyDeletedFields: true,
    });
    expect(await statusOf(guard.svc.deleteDistrict('173'))).toBe(400);

    const merge = make({
      rows: {
        orders: [order('11', '173', '3'), order('12', '173', '3', true)],
      },
      legacyDeletedFields: true,
    });
    const res = await merge.svc.mergeDistricts('173', '28');
    expect(res.statusCode).toBe(200);
    expect(merge.inDistrict('orders', '173')).toEqual([]);
  });

  it('`deleted_*` buzuq bo`lsa — FAIL-CLOSED 503, o`chirilmaydi', async () => {
    const { svc } = make({ badDeletedField: 'users' });
    expect(await statusOf(svc.deleteDistrict('173'))).toBe(503);
    expect(svc.districtRepo.remove).not.toHaveBeenCalled();
  });
});
