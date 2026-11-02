import { RpcException, type RmqContext } from '@nestjs/microservices';
import { FindOperator } from 'typeorm';
import { of, throwError, type Observable } from 'rxjs';
import { ActivityAction, Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';
import { LogisticsServiceController } from './logistics-service.controller';

/**
 * Tuman ↔ filial qamrovi (ega qarori, 2026-11-02): «filialga biriktirilmagan
 * tuman buyurtmasi o'sha filial kuryeriga berilmasin» — logistics tomoni.
 *
 *  - `logistics.district.set_serving_branch` (ALMASHTIRISH semantikasi),
 *    `find_by_branch`, `clear_serving_branch`;
 *  - assign-to-courier va scan-assign qamrov to'sig'i (`isOrderServedByBranch`);
 *  - createCanceledPost: begona CANCELLED_SENT kuryer pochtasiga tortilmaydi.
 *
 * Tuman repo xotirada: `find`/`update` TypeORM'ning haqiqiy FindOperator'larini
 * (In, Not(In)) talqin qiladi — servis yuborgan shartlar aynan sinaladi.
 */
type Row = Record<string, unknown>;
type DistrictRow = {
  id: string;
  name: string;
  region_id: string;
  assigned_region: string | null;
  serving_branch_id: string | null;
};

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

const matchesWhere = (row: Row, where: Row | Row[]): boolean =>
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([key, cond]) => matchValue(row[key], cond)),
  );

const district = (overrides: Partial<DistrictRow> & { id: string }) => ({
  name: `Tuman ${overrides.id}`,
  region_id: '1',
  assigned_region: null,
  serving_branch_id: null,
  ...overrides,
});

function districtRepoOf(initial: DistrictRow[]) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const repo = {
    rows,
    find: jest.fn(({ where }: { where: Row | Row[] }) =>
      Promise.resolve(
        Array.from(rows.values())
          .filter((row) => matchesWhere(row, where))
          .map((row) => ({ ...row })),
      ),
    ),
    update: jest.fn((where: Row, patch: Partial<DistrictRow>) => {
      let affected = 0;
      for (const row of rows.values()) {
        if (matchesWhere(row, where)) {
          Object.assign(row, patch);
          affected += 1;
        }
      }
      return Promise.resolve({ affected });
    }),
    manager: {
      transaction: jest.fn(
        (cb: (manager: { getRepository: () => unknown }) => unknown) =>
          cb({ getRepository: (): unknown => repo }),
      ),
    },
  };
  return repo;
}

type BranchReply = Row | null | 'down';

function branchClientOf(
  branches: Record<string, BranchReply>,
  assignments: Record<string, Row | null> = {},
) {
  return {
    send: jest.fn(
      (pattern: { cmd: string }, payload: Row): Observable<unknown> => {
        if (pattern.cmd === 'branch.find_by_id') {
          const reply = branches[String(payload.id)];
          if (reply === 'down') {
            return throwError(() => new Error('branch-service down'));
          }
          if (!reply) {
            return throwError(() => ({
              statusCode: 404,
              message: 'Branch topilmadi',
            }));
          }
          return of({ statusCode: 200, data: reply });
        }
        if (pattern.cmd === 'branch.user.find_by_user') {
          return of({ data: assignments[String(payload.user_id)] ?? null });
        }
        if (pattern.cmd === 'branch.user.find_by_branch') {
          return of({
            data: [
              { user_id: '44', role: 'COURIER' },
              { user_id: '77', role: 'MANAGER' },
            ],
          });
        }
        if (pattern.cmd === 'branch.find_hq') {
          return of({ data: { id: '1' } });
        }
        return of({ data: null });
      },
    ),
  };
}

const branch = (id: string, overrides: Row = {}): Row => ({
  id,
  type: 'REGIONAL',
  region_id: '1',
  status: 'active',
  ...overrides,
});

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
      data: Row | null;
    };
  }
  throw new Error('RpcException kutilgan edi');
}

/** Servis javobi (`successRes`) — `data` aniq tur bilan. */
async function ok<T = Row>(
  promise: Promise<unknown>,
): Promise<{ statusCode: number; data: T }> {
  return (await promise) as { statusCode: number; data: T };
}

const SA = { id: '1', roles: ['superadmin'] };

describe('logistics.district.set_serving_branch / find_by_branch / clear_serving_branch', () => {
  function setup(
    initial: DistrictRow[],
    branches: Record<string, BranchReply> = {
      '10': branch('10'),
      '11': branch('11'),
    },
  ) {
    const districtRepo = districtRepoOf(initial);
    const branchClient = branchClientOf(branches);
    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LogisticsServiceService(
      {} as any,
      {} as any,
      districtRepo as any,
      { send: jest.fn(() => of({})) } as any,
      branchClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      activityLog as any,
    );
    const servingOf = (id: string) =>
      districtRepo.rows.get(id)?.serving_branch_id ?? null;
    return { service, districtRepo, branchClient, activityLog, servingOf };
  }

  it('ALMASHTIRISH: ro‘yxatdagilar biriktiriladi, ro‘yxatda yo‘q eski tumanlar bo‘shatiladi', async () => {
    const ctx = setup([
      district({ id: '1', serving_branch_id: '10' }),
      district({ id: '2', serving_branch_id: '10' }),
      district({ id: '3' }),
      district({ id: '4', serving_branch_id: '11' }),
    ]);

    const res = await ok(
      ctx.service.setDistrictServingBranch('10', ['2', '3', 3], SA),
    );

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({
      branch_id: '10',
      district_ids: ['2', '3'],
      added: ['3'],
      removed: ['1'],
      moved: [],
    });
    expect(ctx.servingOf('1')).toBeNull();
    expect(ctx.servingOf('2')).toBe('10');
    expect(ctx.servingOf('3')).toBe('10');
    // Boshqa filialning tumani o'zgarmaydi.
    expect(ctx.servingOf('4')).toBe('11');
    expect(ctx.districtRepo.manager.transaction).toHaveBeenCalledTimes(1);
    // Filial tizim so'rovchisi bilan tekshirildi.
    expect(ctx.branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      { id: '10', requester: { id: 'system', roles: ['superadmin'] } },
    );
    // Faqat o'zgargan tumanlar log qilinadi (2 — o'zgarmagan).
    expect(ctx.activityLog.logChange).toHaveBeenCalledTimes(2);
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'District',
        entity_id: '3',
        action: ActivityAction.ASSIGN,
        old_value: { serving_branch_id: null },
        new_value: { serving_branch_id: '10' },
        user_id: '1',
        user_role: 'superadmin',
      }),
    );
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '1',
        action: ActivityAction.UNASSIGN,
        old_value: { serving_branch_id: '10' },
        new_value: { serving_branch_id: null },
      }),
    );
  });

  it('boshqa filialdagi tuman KO‘CHADI va javobda moved (from_branch_id) bilan qaytadi', async () => {
    const ctx = setup([district({ id: '4', serving_branch_id: '11' })]);

    const res = await ok(ctx.service.setDistrictServingBranch('10', ['4'], SA));

    expect(res.data).toMatchObject({
      added: ['4'],
      removed: [],
      moved: [{ district_id: '4', from_branch_id: '11' }],
    });
    expect(ctx.servingOf('4')).toBe('10');
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '4',
        old_value: { serving_branch_id: '11' },
        new_value: { serving_branch_id: '10' },
      }),
    );
  });

  it('bo‘sh ro‘yxat — filialning barcha tumanlari bo‘shatiladi', async () => {
    const ctx = setup([
      district({ id: '1', serving_branch_id: '10' }),
      district({ id: '4', serving_branch_id: '11' }),
    ]);

    const res = await ok(ctx.service.setDistrictServingBranch('10', [], SA));

    expect(res.data).toMatchObject({ added: [], removed: ['1'], moved: [] });
    expect(ctx.servingOf('1')).toBeNull();
    expect(ctx.servingOf('4')).toBe('11');
  });

  it('xizmat viloyati assigned_region bo‘yicha: boshqa viloyatdan biriktirilgan tuman — qabul qilinadi', async () => {
    const ctx = setup([
      district({ id: '5', region_id: '2', assigned_region: '1' }),
    ]);

    const res = await ok(ctx.service.setDistrictServingBranch('10', ['5'], SA));

    expect(res.data.added).toEqual(['5']);
  });

  it('viloyati mos emas — 400 district_region_mismatch, hech narsa yozilmaydi', async () => {
    const ctx = setup([
      district({ id: '1' }),
      district({ id: '6', region_id: '2' }),
      // Geografik viloyati mos, lekin boshqa viloyatga biriktirilgan.
      district({ id: '7', region_id: '1', assigned_region: '3' }),
    ]);

    const error = await rpcError(
      ctx.service.setDistrictServingBranch('10', ['1', '6', '7'], SA),
    );

    expect(error.statusCode).toBe(400);
    expect(error.data).toEqual({
      reason: 'district_region_mismatch',
      details: { district_ids: ['6', '7'], branch_region_id: '1' },
    });
    expect(ctx.districtRepo.update).not.toHaveBeenCalled();
    expect(ctx.activityLog.logChange).not.toHaveBeenCalled();
  });

  it('filial viloyatsiz — viloyat tekshiruvi qo‘llanmaydi', async () => {
    const ctx = setup([district({ id: '6', region_id: '2' })], {
      '10': branch('10', { region_id: null }),
    });

    const res = await ok(ctx.service.setDistrictServingBranch('10', ['6'], SA));

    expect(res.data.added).toEqual(['6']);
  });

  it('HQ filiali — 400 branch_is_hq, hech narsa yozilmaydi', async () => {
    const ctx = setup([district({ id: '1' })], {
      '1': branch('1', { type: 'HQ' }),
    });

    const error = await rpcError(
      ctx.service.setDistrictServingBranch('1', ['1'], SA),
    );

    expect(error.statusCode).toBe(400);
    expect(error.data).toEqual({ reason: 'branch_is_hq' });
    expect(ctx.districtRepo.update).not.toHaveBeenCalled();
  });

  it.each(['PICKUP', 'pickup', null])(
    'kuryersiz filial turi (%s) — 400 branch_type_not_serving, hech narsa yozilmaydi',
    async (type) => {
      const ctx = setup([district({ id: '1' })], {
        '10': branch('10', { type }),
      });

      const error = await rpcError(
        ctx.service.setDistrictServingBranch('10', ['1'], SA),
      );

      expect(error.statusCode).toBe(400);
      expect(error.data).toEqual({ reason: 'branch_type_not_serving' });
      expect(ctx.districtRepo.update).not.toHaveBeenCalled();
    },
  );

  it('HYBRID filial — tuman biriktiriladi', async () => {
    const ctx = setup([district({ id: '1' })], {
      '10': branch('10', { type: 'HYBRID' }),
    });

    const res = await ok<{ added: string[] }>(
      ctx.service.setDistrictServingBranch('10', ['1'], SA),
    );

    expect(res.data.added).toEqual(['1']);
    expect(ctx.servingOf('1')).toBe('10');
  });

  it('nofaol filial — 400 branch_inactive', async () => {
    const ctx = setup([district({ id: '1' })], {
      '10': branch('10', { status: 'inactive' }),
    });

    const error = await rpcError(
      ctx.service.setDistrictServingBranch('10', ['1'], SA),
    );

    expect(error.statusCode).toBe(400);
    expect(error.data).toEqual({ reason: 'branch_inactive' });
    expect(ctx.districtRepo.update).not.toHaveBeenCalled();
  });

  it('filial topilmadi — 404; filial xizmati javob bermadi — 503', async () => {
    const missing = setup([district({ id: '1' })], {});
    expect(
      (
        await rpcError(
          missing.service.setDistrictServingBranch('10', ['1'], SA),
        )
      ).statusCode,
    ).toBe(404);

    const down = setup([district({ id: '1' })], { '10': 'down' });
    expect(
      (await rpcError(down.service.setDistrictServingBranch('10', ['1'], SA)))
        .statusCode,
    ).toBe(503);
    expect(down.districtRepo.update).not.toHaveBeenCalled();
  });

  it('mavjud bo‘lmagan tuman — 404 district_not_found', async () => {
    const ctx = setup([district({ id: '1' })]);

    const error = await rpcError(
      ctx.service.setDistrictServingBranch('10', ['1', '99'], SA),
    );

    expect(error.statusCode).toBe(404);
    expect(error.data).toEqual({
      reason: 'district_not_found',
      details: { district_ids: ['99'] },
    });
    expect(ctx.districtRepo.update).not.toHaveBeenCalled();
  });

  it.each([
    ['manager', { id: '77', roles: ['manager'] }],
    ['logist', { id: '5', roles: ['logist'] }],
    ['so‘rovchisiz', undefined],
  ])('%s — 403, filial ham so‘ralmaydi', async (_label, requester) => {
    const ctx = setup([district({ id: '1' })]);

    const error = await rpcError(
      ctx.service.setDistrictServingBranch('10', ['1'], requester),
    );

    expect(error.statusCode).toBe(403);
    expect(ctx.branchClient.send).not.toHaveBeenCalled();
    expect(ctx.districtRepo.update).not.toHaveBeenCalled();
  });

  it('yaroqsiz id — 400', async () => {
    const ctx = setup([district({ id: '1' })]);

    expect(
      (await rpcError(ctx.service.setDistrictServingBranch('abc', ['1'], SA)))
        .statusCode,
    ).toBe(400);
    expect(
      (await rpcError(ctx.service.setDistrictServingBranch('10', ['x'], SA)))
        .statusCode,
    ).toBe(400);
    expect(
      (await rpcError(ctx.service.setDistrictServingBranch('10', '1', SA)))
        .statusCode,
    ).toBe(400);
  });

  it('find_by_branch — filial tumanlari (relations, nom bo‘yicha)', async () => {
    const ctx = setup([
      district({ id: '1', serving_branch_id: '10' }),
      district({ id: '2', serving_branch_id: '11' }),
    ]);

    const res = await ok<DistrictRow[]>(
      ctx.service.findDistrictsByServingBranch('10'),
    );

    expect(res.data.map((row: DistrictRow) => row.id)).toEqual(['1']);
    expect(ctx.districtRepo.find).toHaveBeenCalledWith({
      where: { serving_branch_id: '10' },
      relations: ['region', 'assignedToRegion'],
      order: { name: 'ASC' },
    });
  });

  it('clear_serving_branch — filialning barcha tumanlari NULL, cleared soni qaytadi', async () => {
    const ctx = setup([
      district({ id: '1', serving_branch_id: '10' }),
      district({ id: '2', serving_branch_id: '10' }),
      district({ id: '3', serving_branch_id: '11' }),
    ]);

    const res = await ok(ctx.service.clearDistrictServingBranch('10'));

    expect(res.data).toEqual({ branch_id: '10', cleared: 2 });
    expect(ctx.servingOf('1')).toBeNull();
    expect(ctx.servingOf('2')).toBeNull();
    expect(ctx.servingOf('3')).toBe('11');
    expect(ctx.activityLog.logChange).toHaveBeenCalledTimes(2);

    // Idempotent: qayta chaqiruv — 0, yozuv yo'q.
    ctx.districtRepo.update.mockClear();
    const again = await ok(ctx.service.clearDistrictServingBranch('10'));
    expect(again.data.cleared).toBe(0);
    expect(ctx.districtRepo.update).not.toHaveBeenCalled();
  });

  it('controller: uchala pattern servisga to‘g‘ri uzatiladi', async () => {
    const logisticsService = {
      setDistrictServingBranch: jest.fn().mockResolvedValue({ ok: 1 }),
      findDistrictsByServingBranch: jest.fn().mockResolvedValue({ ok: 2 }),
      clearDistrictServingBranch: jest.fn().mockResolvedValue({ ok: 3 }),
    };
    const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
    const controller = new LogisticsServiceController(
      rmqService as any,
      logisticsService as any,
      {} as any,
    );
    const context = {
      getPattern: () => 'x',
      getMessage: () => ({}),
    } as unknown as RmqContext;

    await controller.setDistrictServingBranch(
      {
        branch_id: '10',
        district_ids: ['1'],
        requester: { id: 1 as unknown as string, roles: ['admin'] },
      },
      context,
    );
    await controller.findDistrictsByServingBranch({ branch_id: '10' }, context);
    await controller.clearDistrictServingBranch({ branch_id: '10' }, context);

    expect(logisticsService.setDistrictServingBranch).toHaveBeenCalledWith(
      '10',
      ['1'],
      { id: '1', roles: ['admin'] },
    );
    expect(logisticsService.findDistrictsByServingBranch).toHaveBeenCalledWith(
      '10',
    );
    expect(logisticsService.clearDistrictServingBranch).toHaveBeenCalledWith(
      '10',
    );
  });
});

describe('assignOrdersToCourier — tuman qamrovi to‘sig‘i', () => {
  const order = (overrides: Row): Row => ({
    branch_id: '10',
    status: Order_status.RECEIVED,
    courier_id: null,
    post_id: null,
    total_price: 100_000,
    region_id: '1',
    district_id: null,
    ...overrides,
  });

  function setup(options: {
    orders: Row[];
    districts?: DistrictRow[];
    branches?: Record<string, BranchReply>;
    // Menejer 77 biriktiruvidagi filial qatori (undefined — 10-filial, 1-viloyat).
    managerBranch?: Row | null;
  }) {
    const ordersMap = new Map(
      options.orders.map((o) => [String(o.id), { ...o }]),
    );
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload: Row) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of(ordersMap.get(String(payload.id)));
        }
        return of({ statusCode: 200 });
      }),
    };
    const managerBranch =
      options.managerBranch === undefined
        ? branch('10')
        : options.managerBranch;
    const branchClient = branchClientOf(options.branches ?? {}, {
      '77': { branch_id: '10', role: 'MANAGER', branch: managerBranch },
    });
    const identityClient = {
      send: jest.fn(() => of({ data: [{ id: '44', status: 'active' }] })),
    };
    const districtRepo = districtRepoOf(options.districts ?? []);
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((entity: Row) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      districtRepo as any,
      orderClient as any,
      branchClient as any,
      identityClient as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const updates = () =>
      orderClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'order.update',
      );
    return {
      service,
      postRepo,
      identityClient,
      districtRepo,
      branchClient,
      updates,
    };
  }

  const assign = (
    service: LogisticsServiceService,
    orderIds: string[],
    requester: { id: string; roles: string[] } = {
      id: '77',
      roles: ['manager'],
    },
  ) =>
    service.assignOrdersToCourier(requester, {
      order_ids: orderIds,
      courier_id: '44',
    });

  function expectNothingWritten(ctx: ReturnType<typeof setup>) {
    expect(ctx.updates()).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    // Kuryer holati ham so'ralmaydi — to'siq undan OLDIN.
    expect(ctx.identityClient.send).not.toHaveBeenCalled();
  }

  it('tuman xizmat viloyati filial viloyatiga teng — biriktiriladi', async () => {
    const ctx = setup({
      orders: [order({ id: '101', district_id: '5' })],
      districts: [district({ id: '5', region_id: '1' })],
    });

    const res = await ok(assign(ctx.service, ['101']));

    expect(res.data.assigned_count).toBe(1);
  });

  it('⭐ boshqa viloyat tumani — 403 district_not_served_by_branch, hech narsa yozilmaydi (NEW avto-qabul ham)', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101', district_id: '5' }),
        order({ id: '102', district_id: '6', status: Order_status.NEW }),
        order({ id: '103', district_id: null, region_id: '2' }),
      ],
      districts: [
        district({ id: '5', region_id: '1' }),
        district({ id: '6', region_id: '2' }),
      ],
    });

    const error = await rpcError(assign(ctx.service, ['101', '102', '103']));

    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('filialingizga biriktirilmagan');
    expect(error.message).toContain('#102, #103');
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['102', '103'],
    });
    expectNothingWritten(ctx);
  });

  it('⭐ serving_branch_id viloyatdan ustun: viloyat mos, lekin tuman boshqa filialniki — 403', async () => {
    const ctx = setup({
      orders: [order({ id: '101', district_id: '5' })],
      districts: [
        district({ id: '5', region_id: '1', serving_branch_id: '11' }),
      ],
    });

    const error = await rpcError(assign(ctx.service, ['101']));

    expect(error.statusCode).toBe(403);
    expect(error.data?.reason).toBe('district_not_served_by_branch');
    expectNothingWritten(ctx);
  });

  it('serving_branch_id = shu filial — viloyat boshqa bo‘lsa ham biriktiriladi', async () => {
    const ctx = setup({
      orders: [order({ id: '101', district_id: '5', region_id: '2' })],
      districts: [
        district({ id: '5', region_id: '2', serving_branch_id: '10' }),
      ],
    });

    const res = await ok(assign(ctx.service, ['101']));

    expect(res.data.assigned_count).toBe(1);
  });

  it('HQ filiali — cheklanmaydi (tuman so‘ralmaydi)', async () => {
    const ctx = setup({
      orders: [order({ id: '101', branch_id: '1', district_id: '6' })],
      districts: [district({ id: '6', region_id: '2' })],
      branches: { '1': branch('1', { type: 'HQ', region_id: '1' }) },
    });

    const res = await ok(assign(ctx.service, ['101'], SA));

    expect(res.data.assigned_count).toBe(1);
    expect(ctx.districtRepo.find).not.toHaveBeenCalled();
  });

  it('SA/admin: doira filiali — buyurtmalar filiali (branch.find_by_id), qamrov tekshiriladi', async () => {
    const ctx = setup({
      orders: [order({ id: '201', branch_id: '20', district_id: '6' })],
      districts: [district({ id: '6', region_id: '1' })],
      branches: { '20': branch('20', { region_id: '3' }) },
    });

    const error = await rpcError(assign(ctx.service, ['201'], SA));

    expect(error.statusCode).toBe(403);
    expect(ctx.branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      { id: '20', requester: { id: 'system', roles: ['superadmin'] } },
    );
    expectNothingWritten(ctx);
  });

  it('fail closed: biriktiruvda filial qatori yo‘q va branch.find_by_id 404 — 403', async () => {
    const ctx = setup({
      orders: [order({ id: '101' })],
      managerBranch: null,
      branches: {},
    });

    const error = await rpcError(assign(ctx.service, ['101']));

    expect(error.statusCode).toBe(403);
    expect(error.message).toContain("tekshirib bo'lmadi");
    expectNothingWritten(ctx);
  });

  it('fail closed: filial xizmati javob bermadi — 503', async () => {
    const ctx = setup({
      orders: [order({ id: '101' })],
      managerBranch: null,
      branches: { '10': 'down' },
    });

    const error = await rpcError(assign(ctx.service, ['101']));

    expect(error.statusCode).toBe(503);
    expectNothingWritten(ctx);
  });

  it('filial viloyatsiz va tumanga filial biriktirilmagan — 403 (fail closed)', async () => {
    const ctx = setup({
      orders: [order({ id: '101', district_id: '5' })],
      districts: [district({ id: '5', region_id: '1' })],
      managerBranch: branch('10', { region_id: null }),
    });

    const error = await rpcError(assign(ctx.service, ['101']));

    expect(error.statusCode).toBe(403);
    expectNothingWritten(ctx);
  });
});

describe('scanAssignOrder — tuman qamrovi to‘sig‘i', () => {
  function setup(options: {
    order: Row;
    orderAfterReceive?: Row;
    courierBranch: Row;
    districts?: DistrictRow[];
  }) {
    let received = false;
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_qr') {
          return of({
            data:
              received && options.orderAfterReceive
                ? { ...options.order, ...options.orderAfterReceive }
                : options.order,
          });
        }
        if (pattern.cmd === 'order.transfer_batch.receive_one_by_scan') {
          received = true;
          return of({ data: { received: true } });
        }
        return of({ ok: true });
      }),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          return of({ data: { id: '1' } });
        }
        return of({
          data: {
            branch_id: options.courierBranch.id,
            branch: options.courierBranch,
          },
        });
      }),
    };
    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((entity: Row) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
      ),
      createQueryBuilder: jest.fn(() => postUpdateQb),
    };
    const districtRepo = districtRepoOf(options.districts ?? []);
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      districtRepo as any,
      orderClient as any,
      branchClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const calls = (cmd: string) =>
      orderClient.send.mock.calls.filter(([pattern]) => pattern.cmd === cmd);
    return { service, postRepo, districtRepo, calls };
  }

  const scan = (service: LogisticsServiceService) =>
    service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc' },
    );

  const baseOrder = (overrides: Row = {}): Row => ({
    id: '101',
    branch_id: '10',
    status: Order_status.NEW,
    courier_id: null,
    post_id: null,
    total_price: 120_000,
    region_id: '1',
    district_id: '5',
    ...overrides,
  });

  it('o‘z filiali, tuman xizmat qilinadi — biriktiriladi', async () => {
    const ctx = setup({
      order: baseOrder(),
      courierBranch: branch('10'),
      districts: [district({ id: '5', region_id: '1' })],
    });

    const res = await ok(scan(ctx.service));

    expect(res.data.idempotent).toBe(false);
    expect(ctx.calls('order.update')).toHaveLength(2);
  });

  it('⭐ to‘g‘ridan-to‘g‘ri yo‘l: tuman boshqa filialniki — 403, NEW → RECEIVED ham, pochta ham yo‘q', async () => {
    const ctx = setup({
      order: baseOrder(),
      courierBranch: branch('10'),
      districts: [
        district({ id: '5', region_id: '1', serving_branch_id: '11' }),
      ],
    });

    const error = await rpcError(scan(ctx.service));

    expect(error.statusCode).toBe(403);
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['101'],
    });
    expect(error.message).not.toContain('qabul qilindi');
    expect(ctx.calls('order.update')).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('⭐ P1b yo‘li: qabuldan keyin qayta o‘qilgan buyurtma tumani filialga tegishli emas — 403, kuryerga berilmaydi', async () => {
    const ctx = setup({
      order: baseOrder({ branch_id: '99', status: Order_status.ON_THE_ROAD }),
      orderAfterReceive: {
        branch_id: '10',
        status: Order_status.RECEIVED,
        district_id: '6',
      },
      courierBranch: branch('10'),
      districts: [district({ id: '6', region_id: '2' })],
    });

    const error = await rpcError(scan(ctx.service));

    expect(error.statusCode).toBe(403);
    expect(error.data?.order_ids).toEqual(['101']);
    // Xabar mas'uliyat filialga o'tganini aytadi.
    expect(error.message).toContain(
      'posilka filialingizga qabul qilindi, lekin kuryerga berilmaydi',
    );
    // Filial qabuli bajarildi (posilka filialda), lekin kuryerga yozuv yo'q.
    expect(ctx.calls('order.transfer_batch.receive_one_by_scan')).toHaveLength(
      1,
    );
    expect(ctx.calls('order.update')).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('P1b yo‘li: qayta o‘qilgan buyurtma tumani xizmat qilinadi — biriktiriladi', async () => {
    const ctx = setup({
      order: baseOrder({ branch_id: '99', status: Order_status.ON_THE_ROAD }),
      orderAfterReceive: { branch_id: '10', status: Order_status.RECEIVED },
      courierBranch: branch('10'),
      districts: [district({ id: '5', region_id: '1' })],
    });

    const res = await ok(scan(ctx.service));

    expect(res.data.order_id).toBe('101');
    expect(ctx.calls('order.update')).toHaveLength(1);
  });

  it('HQ kuryeri — cheklanmaydi (tuman so‘ralmaydi)', async () => {
    const ctx = setup({
      order: baseOrder({
        branch_id: '1',
        status: Order_status.RECEIVED,
        holder_type: 'HQ',
        district_id: '6',
      }),
      courierBranch: branch('1', { type: 'HQ' }),
      districts: [district({ id: '6', region_id: '2' })],
    });

    const res = await ok(scan(ctx.service));

    expect(res.data.idempotent).toBe(false);
    expect(ctx.districtRepo.find).not.toHaveBeenCalled();
  });
});

describe('createCanceledPost — begona CANCELLED_SENT kuryer pochtasiga tortilmaydi', () => {
  function setup(options: { order: Row; posts?: Row[] }) {
    const posts = new Map(
      (options.posts ?? []).map((post) => [String(post.id), post]),
    );
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of(options.order);
        }
        return of({ statusCode: 200 });
      }),
    };
    const postRepo = {
      findOne: jest.fn(
        ({ where }: { where: { id?: string; status?: string } }) => {
          if (where.id !== undefined) {
            const post = posts.get(String(where.id));
            if (!post) return Promise.resolve(null);
            if (where.status !== undefined && where.status !== post.status) {
              return Promise.resolve(null);
            }
            return Promise.resolve({ ...post });
          }
          // Kuryerning faol CANCELED pochtasi yo'q.
          return Promise.resolve(null);
        },
      ),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((post: Row) =>
        Promise.resolve({ ...post, id: post.id ?? '55' }),
      ),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: { branch_id: '10', role: 'COURIER' } })),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      {} as any,
      {} as any,
      { log: jest.fn(), query: jest.fn() } as any,
    );
    const updates = () =>
      orderClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'order.update',
      );
    return { service, postRepo, updates };
  }

  const send = (service: LogisticsServiceService) =>
    service.createCanceledPost(
      { id: '7', roles: ['courier'] },
      { order_ids: ['101'] },
    );

  const sentOrder = (overrides: Row): Row => ({
    id: '101',
    status: Order_status.CANCELLED_SENT,
    canceled_post_id: '90',
    courier_id: null,
    holder_type: 'BRANCH',
    total_price: 1_000_000,
    region_id: '1',
    ...overrides,
  });

  it('⭐ boshqa filial kuryerining jo‘natilgan qaytishi — 403, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      order: sentOrder({ branch_id: '20', holder_branch_id: '20' }),
      posts: [
        {
          id: '90',
          courier_id: '99',
          branch_id: '20',
          status: Post_status.CANCELED,
        },
      ],
    });

    const error = await rpcError(send(ctx.service));

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      "Jo'natilgan qaytish boshqa kuryer/filialga tegishli",
    );
    expect(ctx.updates()).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('⭐ pochtasi topilmagan begona qaytish — 403', async () => {
    const ctx = setup({
      order: sentOrder({ branch_id: '20', canceled_post_id: '404' }),
    });

    expect((await rpcError(send(ctx.service))).statusCode).toBe(403);
    expect(ctx.updates()).toHaveLength(0);
  });

  it('o‘z NOFAOL (qabul qilingan) pochtasidagi qaytish — ruxsat, faol pochtaga ko‘chiriladi', async () => {
    const ctx = setup({
      order: sentOrder({ branch_id: '20', holder_branch_id: '20' }),
      posts: [
        {
          id: '90',
          courier_id: '7',
          branch_id: '10',
          status: Post_status.CANCELED_RECEIVED,
        },
      ],
    });

    const res = await ok(send(ctx.service));

    expect(res.statusCode).toBe(200);
    // Egalik pochtasi holat filtrisiz o'qildi.
    expect(ctx.postRepo.findOne).toHaveBeenCalledWith({ where: { id: '90' } });
    expect(ctx.updates()).toHaveLength(1);
    expect(ctx.postRepo.save).toHaveBeenCalled();
  });

  it('o‘z filialida turgan qaytish (boshqa kuryerniki) — avvalgidek ruxsat', async () => {
    const ctx = setup({
      order: sentOrder({ branch_id: '10', holder_branch_id: '10' }),
      posts: [
        {
          id: '90',
          courier_id: '99',
          branch_id: '10',
          status: Post_status.CANCELED_RECEIVED,
        },
      ],
    });

    const res = await ok(send(ctx.service));

    expect(res.statusCode).toBe(200);
  });
});
