import { Observable, of, throwError } from 'rxjs';
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
type GeoRow = { id: string; district_id: string; region_id: string | null };
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
    /** Eski order-service: `transfer_batches` maydonini qaytarmaydi. */
    legacyOrderUsage?: boolean;
    usageDown?: boolean;
    posts?: number;
    regionDistricts?: number;
    /** Oddiy (A → B) ko'chirish yiqilishi. */
    forwardFault?: Partial<Record<Kind, Fault>>;
    /** Kompensatsiya (ID rejimi, B → A) yiqilishi. */
    compensateFault?: Partial<Record<Kind, Fault>>;
    /** Oddiy ko'chirishdan keyin (parallel yozuv simulyatsiyasi). */
    afterForward?: (kind: Kind, rows: Record<Kind, GeoRow[]>) => void;
    removeFails?: boolean;
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
    count: jest.fn(() => Promise.resolve(opts.regionDistricts ?? 0)),
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
    const data: Record<string, unknown> = { [kind]: list.length };
    if (kind === 'orders' && !opts.legacyOrderUsage) {
      data.transfer_batches = where.district_id
        ? 0
        : (opts.batches ?? []).filter((r) => r === String(where.region_id))
            .length;
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

const order = (id: string, district_id: string, region_id: string | null) => ({
  id,
  district_id,
  region_id,
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
    expect(svc.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '173',
        action: 'deleted',
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
