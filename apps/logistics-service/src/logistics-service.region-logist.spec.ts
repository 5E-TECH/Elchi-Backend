import { RpcException } from '@nestjs/microservices';
import { FindOperator } from 'typeorm';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import { ActivityAction } from '@app/common';
import {
  LOGIST_CHECK_UNAVAILABLE_MESSAGE,
  LOGIST_INACTIVE_MESSAGE,
  LOGIST_NOT_FOUND_MESSAGE,
  LogisticsServiceService,
} from './logistics-service.service';
import { LogisticsServiceController } from './logistics-service.controller';

/**
 * (dzyVftBx) Viloyatga logist biriktirish domeni (logistics tomoni).
 *
 * TC1 — bulk: faqat berilgan viloyatlar logist_id oladi, logistning
 *       qolgan viloyatlaridan u olinadi; boshqa logistlar o'zgarmaydi.
 * TC2 — logist_id: null → viloyatdan logist olib tashlanadi.
 * TC4 — logist o'chirilganda (clear_logist) regions.logist_id NULL bo'ladi,
 *       viloyatning o'zi o'chmaydi.
 *
 * Repo xotirada: `find`/`update` TypeORM'ning haqiqiy FindOperator'larini
 * (In, Not(In)) talqin qiladi — servis yuborgan shartlar aynan sinaladi.
 */
type RegionRow = { id: string; name: string; logist_id: string | null };

const matchValue = (value: unknown, cond: unknown): boolean => {
  if (cond instanceof FindOperator) {
    if (cond.type === 'in') {
      return (cond.value as unknown[]).map(String).includes(String(value));
    }
    if (cond.type === 'not') {
      return cond.child
        ? !matchValue(value, cond.child)
        : value !== (cond.value as unknown);
    }
    throw new Error(`Qo'llab-quvvatlanmagan operator: ${cond.type}`);
  }
  return value === cond;
};

const matchesWhere = (
  row: Record<string, unknown>,
  where: Record<string, unknown> | Record<string, unknown>[],
): boolean =>
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([key, cond]) => matchValue(row[key], cond)),
  );

type IdentityReply = () => Observable<unknown>;

const logistRow = (overrides: Record<string, unknown> = {}) => ({
  id: '42',
  name: 'Shaxriyor',
  role: 'logist',
  status: 'active',
  ...overrides,
});

function setup(
  initial: RegionRow[],
  identityReply: IdentityReply = () => of({ data: [logistRow()] }),
) {
  const rows = new Map<string, RegionRow>(
    initial.map((row) => [row.id, { ...row }]),
  );
  const calls: string[] = [];
  const regionRepo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const row = Array.from(rows.values()).find((r) => matchesWhere(r, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    find: jest.fn(
      ({
        where,
      }: {
        where: Record<string, unknown> | Record<string, unknown>[];
      }) =>
        Promise.resolve(
          Array.from(rows.values())
            .filter((r) => matchesWhere(r, where))
            .map((r) => ({ ...r })),
        ),
    ),
    update: jest.fn(
      (where: Record<string, unknown>, patch: Partial<RegionRow>) => {
        calls.push('update');
        let affected = 0;
        for (const row of rows.values()) {
          if (matchesWhere(row, where)) {
            Object.assign(row, patch);
            affected += 1;
          }
        }
        return Promise.resolve({ affected });
      },
    ),
    save: jest.fn((entity: RegionRow) => {
      calls.push('save');
      rows.set(entity.id, { ...entity });
      return Promise.resolve({ ...entity });
    }),
    remove: jest.fn(),
    delete: jest.fn(),
    manager: {
      transaction: jest.fn(
        (cb: (manager: { getRepository: () => unknown }) => unknown) => {
          calls.push('transaction');
          return cb({ getRepository: () => regionRepo });
        },
      ),
    },
  };
  const identityClient = { send: jest.fn(() => identityReply()) };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new LogisticsServiceService(
    {} as any,
    regionRepo,
    {} as any,
    { send: jest.fn(() => of({})) } as any, // order
    { send: jest.fn(() => of({})) } as any, // branch
    identityClient as any, // identity
    { send: jest.fn(() => of({})) } as any, // search
    activityLog as any,
  );
  const state = () =>
    Object.fromEntries(
      Array.from(rows.values()).map((row) => [row.id, row.logist_id]),
    );
  return { service, regionRepo, identityClient, activityLog, state, calls };
}

const admin = { id: '1', roles: ['admin'] };

async function expectRpcStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
    throw new Error('Expected RpcException');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect(
      ((error as RpcException).getError() as { statusCode?: number })
        .statusCode,
    ).toBe(status);
    return (error as RpcException).getError() as { message?: string };
  }
}

const regions = (): RegionRow[] => [
  { id: '1', name: 'Andijon', logist_id: '42' },
  { id: '2', name: 'Buxoro', logist_id: '42' },
  { id: '3', name: 'Jizzax', logist_id: null },
  { id: '4', name: 'Navoiy', logist_id: '9' },
  { id: '5', name: 'Namangan', logist_id: null },
  { id: '6', name: 'Xorazm', logist_id: '9' },
];

describe('(dzyVftBx) TC1 — POST /region/logist/bulk', () => {
  it('⭐ faqat berilgan viloyatlar logist oladi, logistning qolganlaridan u olinadi', async () => {
    const ctx = setup(regions());

    const res: any = await ctx.service.bulkAssignRegionLogist(
      '42',
      ['2', '3', '4'],
      admin,
    );

    expect(res.statusCode).toBe(200);
    expect(ctx.state()).toEqual({
      '1': null, // logistning tanlanmagan viloyati — olib tashlandi
      '2': '42', // o'zi qoldi
      '3': '42', // yangi
      '4': '42', // boshqa logistdan (9) o'tdi
      '5': null, // tegilmadi
      '6': '9', // boshqa logistning qolgan viloyati — o'zgarmadi
    });
    expect(res.data).toEqual({
      logist_id: '42',
      region_ids: ['2', '3', '4'],
      removed_region_ids: ['1'],
      reassigned_from: [{ region_id: '4', logist_id: '9' }],
    });
    expect(ctx.identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.logist.find_by_ids' },
      { ids: ['42'] },
    );
    // Ikkala UPDATE bitta tranzaksiyada.
    expect(ctx.regionRepo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(ctx.calls).toEqual(['transaction', 'update', 'update']);
  });

  it('audit: faqat haqiqatan o‘zgargan viloyatlar, eski/yangi logist_id va so‘rovchi bilan', async () => {
    const ctx = setup(regions());

    await ctx.service.bulkAssignRegionLogist('42', ['2', '3', '4'], admin);

    const logged = ctx.activityLog.logChange.mock.calls.map(
      ([entry]: [any]) => [
        entry.entity_id,
        entry.action,
        entry.old_value,
        entry.new_value,
      ],
    );
    expect(logged).toEqual(
      expect.arrayContaining([
        [
          '1',
          ActivityAction.UNASSIGN,
          { logist_id: '42' },
          { logist_id: null },
        ],
        ['3', ActivityAction.ASSIGN, { logist_id: null }, { logist_id: '42' }],
        ['4', ActivityAction.ASSIGN, { logist_id: '9' }, { logist_id: '42' }],
      ]),
    );
    // '2' o'zgarmadi — yozuv yo'q.
    expect(logged.map(([id]) => id)).not.toContain('2');
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '1', user_role: 'admin' }),
    );
  });

  it('region_ids: [] — logist hamma viloyatidan olinadi, boshqalar o‘zgarmaydi', async () => {
    const ctx = setup(regions());

    const res: any = await ctx.service.bulkAssignRegionLogist('42', [], admin);

    expect(res.statusCode).toBe(200);
    expect(ctx.state()).toEqual({
      '1': null,
      '2': null,
      '3': null,
      '4': '9',
      '5': null,
      '6': '9',
    });
    expect(res.data.removed_region_ids.sort()).toEqual(['1', '2']);
  });

  it('id lar kanonik va takrorsiz (raqam, "05", dublikat)', async () => {
    const ctx = setup(regions());

    const res: any = await ctx.service.bulkAssignRegionLogist(
      42 as unknown as string,
      ['05', 5, '5', '3'],
      admin,
    );

    expect(res.data.region_ids).toEqual(['5', '3']);
    expect(ctx.state()['5']).toBe('42');
    expect(ctx.state()['3']).toBe('42');
  });

  it('mavjud bo‘lmagan viloyat → 404, hech narsa o‘zgarmaydi, identity chaqirilmaydi', async () => {
    const ctx = setup(regions());
    const before = ctx.state();

    const err = await expectRpcStatus(
      ctx.service.bulkAssignRegionLogist('42', ['2', '777'], admin),
      404,
    );

    expect(err.message).toContain('777');
    expect(ctx.state()).toEqual(before);
    expect(ctx.regionRepo.update).not.toHaveBeenCalled();
    expect(ctx.identityClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['region_ids massiv emas', '42', '2'],
    ['region_ids da raqam emas', '42', ['2', 'abc']],
    ['region_ids da 0', '42', ['0']],
    ['bigint dan katta id', '42', ['99999999999999999999']],
    ['logist_id buzuq', '4.2', ['2']],
    ['logist_id yo‘q', undefined, ['2']],
    ['logist_id null va region_ids bo‘sh', null, []],
  ])('%s → 400, hech narsa o‘zgarmaydi', async (_label, logistId, ids) => {
    const ctx = setup(regions());
    const before = ctx.state();

    await expectRpcStatus(
      ctx.service.bulkAssignRegionLogist(logistId, ids, admin),
      400,
    );

    expect(ctx.state()).toEqual(before);
    expect(ctx.regionRepo.update).not.toHaveBeenCalled();
  });
});

describe('(dzyVftBx) logist_id faqat haqiqiy FAOL LOGIST (identity RPC)', () => {
  it.each([
    ['identity hech narsa qaytarmadi (yo‘q yoki o‘chirilgan) → 404', [], 404],
    ['boshqa rol (kuryer) → 404', [logistRow({ role: 'courier' })], 404],
    ['bloklangan logist → 400', [logistRow({ status: 'inactive' })], 400],
  ])('%s, hech narsa yozilmaydi', async (_label, data, status) => {
    const ctx = setup(regions(), () => of({ data }));
    const before = ctx.state();

    const err = await expectRpcStatus(
      ctx.service.bulkAssignRegionLogist('42', ['3'], admin),
      status,
    );

    expect(err.message).toBe(
      status === 404 ? LOGIST_NOT_FOUND_MESSAGE : LOGIST_INACTIVE_MESSAGE,
    );
    expect(ctx.state()).toEqual(before);
  });

  it.each([
    ['identity xato berdi', () => throwError(() => new Error('boom'))],
    ['javob shakli buzuq', () => of({ data: 'x' })],
  ])('%s → 503 (fail-closed), hech narsa yozilmaydi', async (_l, reply) => {
    const ctx = setup(regions(), reply);
    const before = ctx.state();

    const err = await expectRpcStatus(
      ctx.service.assignRegionLogist('3', '42', admin),
      503,
    );

    expect(err.message).toBe(LOGIST_CHECK_UNAVAILABLE_MESSAGE);
    expect(ctx.state()).toEqual(before);
    expect(ctx.regionRepo.save).not.toHaveBeenCalled();
  });

  it('identity javob bermasa (timeout) → 503', async () => {
    jest.useFakeTimers();
    try {
      const ctx = setup(regions(), () => NEVER);
      const promise = ctx.service.assignRegionLogist('3', '42', admin);
      const assertion = expectRpcStatus(promise, 503);
      await jest.advanceTimersByTimeAsync(5001);
      await assertion;
      expect(ctx.regionRepo.save).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('(dzyVftBx) PATCH /region/:id/logist', () => {
  it('logist biriktiriladi: ASSIGN yoziladi, javobda viloyat', async () => {
    const ctx = setup(regions());

    const res: any = await ctx.service.assignRegionLogist('3', '42', admin);

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Logist biriktirildi');
    expect(res.data).toEqual(
      expect.objectContaining({ id: '3', logist_id: '42' }),
    );
    expect(ctx.state()['3']).toBe('42');
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Region',
        entity_id: '3',
        action: ActivityAction.ASSIGN,
        old_value: { logist_id: null },
        new_value: { logist_id: '42' },
        metadata: { logist_name: 'Shaxriyor' },
        user_id: '1',
      }),
    );
  });

  it('⭐ TC2: logist_id: null — viloyatdan logist olib tashlanadi, viloyat qoladi, identity chaqirilmaydi', async () => {
    const ctx = setup(regions());

    const res: any = await ctx.service.assignRegionLogist('1', null, admin);

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Logist olib tashlandi');
    expect(ctx.state()['1']).toBeNull();
    expect(ctx.state()['2']).toBe('42'); // logistning boshqa viloyati tegilmadi
    expect(ctx.regionRepo.remove).not.toHaveBeenCalled();
    expect(ctx.identityClient.send).not.toHaveBeenCalled();
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ActivityAction.UNASSIGN,
        old_value: { logist_id: '42' },
        new_value: { logist_id: null },
      }),
    );
  });

  it('TC2 (bulk): logist_id: null — faqat region_ids dagilardan olinadi', async () => {
    const ctx = setup(regions());

    const res: any = await ctx.service.bulkAssignRegionLogist(
      null,
      ['1', '4'],
      admin,
    );

    expect(res.statusCode).toBe(200);
    expect(ctx.state()).toEqual({
      '1': null,
      '2': '42',
      '3': null,
      '4': null,
      '5': null,
      '6': '9',
    });
    expect(ctx.identityClient.send).not.toHaveBeenCalled();
  });

  it('logist_id yuborilmasa → 400 (tasodifiy olib tashlash yo‘q)', async () => {
    const ctx = setup(regions());

    await expectRpcStatus(
      ctx.service.assignRegionLogist('1', undefined, admin),
      400,
    );

    expect(ctx.state()['1']).toBe('42');
  });

  it.each(['abc', '0', '-1'])('region id %s → 400', async (id) => {
    const ctx = setup(regions());

    await expectRpcStatus(ctx.service.assignRegionLogist(id, '42', admin), 400);
    expect(ctx.regionRepo.findOne).not.toHaveBeenCalled();
  });

  it('viloyat topilmasa → 404, identity chaqirilmaydi', async () => {
    const ctx = setup(regions());

    await expectRpcStatus(
      ctx.service.assignRegionLogist('777', '42', admin),
      404,
    );
    expect(ctx.identityClient.send).not.toHaveBeenCalled();
  });
});

describe('(dzyVftBx) RBAC — faqat superadmin/admin', () => {
  it.each([
    ['market', { id: '201', roles: ['market'] }],
    ['courier', { id: '179', roles: ['courier'] }],
    ['manager', { id: '198', roles: ['manager'] }],
    ['logist', { id: '42', roles: ['logist'] }],
    ['so‘rovchisiz', undefined],
  ])('%s — 403, hech narsa o‘qilmaydi/yozilmaydi', async (_l, requester) => {
    const ctx = setup(regions());

    await expectRpcStatus(
      ctx.service.assignRegionLogist('3', '42', requester),
      403,
    );
    await expectRpcStatus(
      ctx.service.bulkAssignRegionLogist('42', ['3'], requester),
      403,
    );

    expect(ctx.regionRepo.findOne).not.toHaveBeenCalled();
    expect(ctx.regionRepo.find).not.toHaveBeenCalled();
    expect(ctx.regionRepo.update).not.toHaveBeenCalled();
  });

  it('superadmin — ruxsat', async () => {
    const ctx = setup(regions());
    const res: any = await ctx.service.assignRegionLogist('3', '42', {
      id: '1',
      roles: ['superadmin'],
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('(dzyVftBx) TC4 — logistics.region.clear_logist', () => {
  it('⭐ logistning barcha viloyatlarida logist_id NULL, viloyatlar o‘chmaydi, boshqalar o‘zgarmaydi', async () => {
    const ctx = setup(regions());

    const res: any = await ctx.service.clearLogistFromRegions('42', {
      id: '1',
      roles: ['superadmin'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ logist_id: '42', region_ids: ['1', '2'] });
    expect(ctx.state()).toEqual({
      '1': null,
      '2': null,
      '3': null,
      '4': '9',
      '5': null,
      '6': '9',
    });
    expect(ctx.regionRepo.remove).not.toHaveBeenCalled();
    expect(ctx.regionRepo.delete).not.toHaveBeenCalled();
    expect(ctx.activityLog.logChange).toHaveBeenCalledTimes(2);
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '1',
        action: ActivityAction.UNASSIGN,
        metadata: { reason: 'logist_deleted' },
      }),
    );
  });

  it('idempotent: qayta chaqirish xavfsiz (bo‘sh natija, UPDATE yo‘q)', async () => {
    const ctx = setup(regions());
    await ctx.service.clearLogistFromRegions('42');
    ctx.regionRepo.update.mockClear();

    const res: any = await ctx.service.clearLogistFromRegions('42');

    expect(res.data.region_ids).toEqual([]);
    expect(ctx.regionRepo.update).not.toHaveBeenCalled();
  });

  it('buzuq logist_id → 400', async () => {
    const ctx = setup(regions());
    await expectRpcStatus(ctx.service.clearLogistFromRegions('x'), 400);
    expect(ctx.regionRepo.update).not.toHaveBeenCalled();
  });
});

describe('(dzyVftBx) RPC controller — payload servisga to‘g‘ri uzatiladi', () => {
  const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
  const context = { getPattern: () => 'x' } as any;
  const build = () => {
    const service = {
      assignRegionLogist: jest.fn().mockResolvedValue({ statusCode: 200 }),
      bulkAssignRegionLogist: jest.fn().mockResolvedValue({ statusCode: 200 }),
      clearLogistFromRegions: jest.fn().mockResolvedValue({ statusCode: 200 }),
    };
    const controller = new LogisticsServiceController(
      rmqService as any,
      service as any,
      {} as any,
    );
    return { controller, service };
  };

  it('assign_logist / bulk_assign_logist / clear_logist', async () => {
    const { controller, service } = build();
    const requester = { id: 1 as unknown as string, roles: ['admin'] };

    await controller.assignRegionLogist(
      { id: '3', logist_id: null, requester },
      context,
    );
    await controller.bulkAssignRegionLogist(
      { logist_id: '42', region_ids: ['1'], requester },
      context,
    );
    await controller.clearRegionLogist({ logist_id: '42' }, context);

    expect(service.assignRegionLogist).toHaveBeenCalledWith('3', null, {
      id: '1',
      roles: ['admin'],
    });
    expect(service.bulkAssignRegionLogist).toHaveBeenCalledWith('42', ['1'], {
      id: '1',
      roles: ['admin'],
    });
    expect(service.clearLogistFromRegions).toHaveBeenCalledWith(
      '42',
      undefined,
    );
  });
});

describe('(dzyVftBx) stats/all — har viloyat qatorida logist_id', () => {
  it('logist_id qaytadi (yo‘q bo‘lsa null)', async () => {
    const ctx = setup([]);
    (ctx.regionRepo.find as jest.Mock).mockResolvedValueOnce([
      { id: '1', name: 'Andijon', sato_code: '1703', logist_id: '42' },
      { id: '2', name: 'Buxoro', sato_code: '1706', logist_id: null },
    ]);
    jest.spyOn(ctx.service as any, 'findOrders').mockResolvedValue([] as never);

    const res: any = await ctx.service.getAllRegionsStats();

    expect(res.data.regions.map((r: any) => [r.id, r.logist_id])).toEqual([
      ['1', '42'],
      ['2', null],
    ]);
  });
});
