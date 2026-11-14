import { RpcException } from '@nestjs/microservices';
import { FindOperator } from 'typeorm';
import { of, throwError, type Observable } from 'rxjs';
import { ActivityAction } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';
import { satoRegions } from './data/sato-codes';

/**
 * D1 (ega qarori, 2026-11-14): yetishmagan rasmiy tumanlar seed bilan
 * qo'shiladi, filial AVTOMATIK biriktiriladi va «tekshirilmagan» belgisini
 * oladi; ops tasdiqlaydi yoki qayta biriktiradi. Sintetik ma'lumot.
 */
type Row = Record<string, unknown>;

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
    throw new Error(`operator: ${cond.type}`);
  }
  return value === cond;
};
const matchesWhere = (row: Row, where: Row | Row[]): boolean =>
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([key, cond]) => matchValue(row[key], cond)),
  );

function districtRepoOf(initial: Row[]) {
  const rows = new Map(initial.map((row) => [String(row.id), { ...row }]));
  let nextId = 900;
  const repo = {
    rows,
    find: jest.fn((opts?: { where?: Row | Row[] }) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => !opts?.where || matchesWhere(row, opts.where))
          .map((row) => ({ ...row })),
      ),
    ),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        [...rows.values()].find((row) => matchesWhere(row, where)) ?? null,
      ),
    ),
    create: jest.fn((row: Row) => ({ ...row })),
    save: jest.fn((row: Row) => {
      const saved = { isDeleted: false, ...row, id: String(nextId++) };
      rows.set(saved.id, saved);
      return Promise.resolve({ ...saved });
    }),
    update: jest.fn((where: Row, patch: Row) => {
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

const d = (id: string, over: Row = {}): Row => ({
  id,
  name: `Tuman ${id}`,
  region_id: '1',
  assigned_region: null,
  serving_branch_id: null,
  sato_code: null,
  isDeleted: false,
  assignment_review_required: false,
  assignment_review_reason: null,
  assignment_flagged_at: null,
  assignment_confirmed_by: null,
  assignment_confirmed_at: null,
  ...over,
});

function setup(
  districts: Row[],
  opts: {
    regions?: Row[];
    branches?: Record<string, Row | 'down'>;
  } = {},
) {
  const districtRepo = districtRepoOf(districts);
  const regions = opts.regions ?? [
    { id: '1', name: "Farg'ona viloyati", sato_code: '1730' },
  ];
  const regionRepo = {
    find: jest.fn(() => Promise.resolve(regions.map((r) => ({ ...r })))),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(regions.find((r) => matchesWhere(r, where)) ?? null),
    ),
    create: jest.fn((row: Row) => ({ ...row })),
    save: jest.fn((row: Row) => Promise.resolve({ ...row, id: 'new' })),
  };
  const branches = opts.branches ?? {
    '10': {
      id: '10',
      name: "Farg'ona filiali",
      type: 'REGIONAL',
      status: 'active',
      region_id: '1',
    },
    '11': {
      id: '11',
      name: 'Quva filiali',
      type: 'REGIONAL',
      status: 'active',
      region_id: '1',
    },
  };
  const branchClient = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: Row): Observable<unknown> => {
        if (pattern.cmd === 'branch.find_by_id') {
          const reply = branches[String(payload.id)];
          if (reply === 'down') return throwError(() => new Error('down'));
          if (!reply) return throwError(() => ({ statusCode: 404 }));
          return of({ statusCode: 200, data: reply });
        }
        return of({ data: null });
      },
    ),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new LogisticsServiceService(
    {} as any,
    regionRepo as any,
    districtRepo as any,
    { send: jest.fn(() => of({})) } as any,
    branchClient as any,
    { send: jest.fn(() => of({})) } as any,
    { send: jest.fn(() => of({})) } as any,
    activityLog as any,
  );
  jest
    .spyOn(service as any, 'syncDistrictToSearch')
    .mockImplementation(() => Promise.resolve());
  jest
    .spyOn(service as any, 'syncRegionToSearch')
    .mockImplementation(() => Promise.resolve());
  return { service, districtRepo, regionRepo, activityLog, branchClient };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as { statusCode: number };
  }
  throw new Error('RpcException kutilgan edi');
}

const SA = { id: '7', roles: ['superadmin'] };
const ADMIN = { id: '8', roles: ['admin'] };
const MANAGER = { id: '9', roles: ['manager'] };

describe('D1: seedAutoAssignment', () => {
  const auto = (ctx: ReturnType<typeof setup>, name: string) =>
    (ctx.service as any).seedAutoAssignment('1', name);

  it('shahar/tuman jufti — juftning filiali', async () => {
    const ctx = setup([
      d('1', { name: "Farg'ona", serving_branch_id: '11' }),
      d('2', { serving_branch_id: '10' }),
      d('3', { serving_branch_id: '10' }),
    ]);
    await expect(auto(ctx, "Farg'ona shahri")).resolves.toEqual({
      branch_id: '11',
      reason: 'auto_assigned_D1',
    });
  });

  it('jufti yo‘q — viloyatda eng ko‘p tumanga xizmat qiladigan filial; teng bo‘lsa kichik id', async () => {
    let ctx = setup([
      d('1', { serving_branch_id: '11' }),
      d('2', { serving_branch_id: '10' }),
      d('3', { serving_branch_id: '10' }),
    ]);
    await expect(auto(ctx, "Qo'shtepa tumani")).resolves.toEqual({
      branch_id: '10',
      reason: 'auto_assigned_D1',
    });
    ctx = setup([
      d('1', { serving_branch_id: '11' }),
      d('2', { serving_branch_id: '9' }),
    ]);
    await expect(auto(ctx, "Qo'shtepa tumani")).resolves.toEqual({
      branch_id: '9',
      reason: 'auto_assigned_D1',
    });
  });

  it('o‘chirilgan / boshqa viloyat qatorlari hisobga olinmaydi; filial yo‘q — no_branch_found', async () => {
    const ctx = setup([
      d('1', { serving_branch_id: '10', isDeleted: true }),
      d('2', { serving_branch_id: '10', region_id: '2' }),
      d('3'),
    ]);
    await expect(auto(ctx, "Qo'shtepa tumani")).resolves.toEqual({
      branch_id: null,
      reason: 'no_branch_found',
    });
  });
});

describe('D1: onModuleInit seed', () => {
  it('MAVJUD viloyatga qo‘shilgan tuman — avtomatik filial + belgi + audit; bor tumanlar tegilmaydi', async () => {
    // Farg'ona viloyatida seed'dagi hamma tuman bor, faqat "Farg'ona shahri" yo'q.
    const { regions } = jest.requireActual('./data/regions-districts.data');
    const fergana = regions.find((r: Row) => r.sato_code === '1730');
    const existing = (fergana.districts as Row[])
      .filter((x) => x.name !== "Farg'ona shahri")
      .map((x, i) =>
        d(String(i + 1), {
          name: x.name,
          sato_code: x.sato_code,
          serving_branch_id: x.name === "Farg'ona" ? '11' : '10',
        }),
      );
    const ctx = setup(existing, {
      regions: [{ id: '1', name: fergana.name.trim(), sato_code: '1730' }],
    });
    // Boshqa viloyatlar seed'i bu testda e'tiborsiz: ular "yangi" bo'lib
    // yaratiladi — belgisiz (bo'sh baza holati).
    await ctx.service.onModuleInit();

    const added = [...ctx.districtRepo.rows.values()].filter(
      (r) => r.region_id === '1' && !existing.some((e) => e.id === r.id),
    );
    expect(added).toEqual([
      expect.objectContaining({
        name: "Farg'ona shahri",
        sato_code: '1730401',
        serving_branch_id: '11',
        assignment_review_required: true,
        assignment_review_reason: 'auto_assigned_D1',
        assignment_flagged_at: expect.any(Date),
      }),
    ]);
    // Yangi (bo'sh) viloyatlar qatorlari — belgisiz.
    const fresh = [...ctx.districtRepo.rows.values()].filter(
      (r) => r.region_id === 'new',
    );
    expect(fresh.length).toBeGreaterThan(100);
    expect(fresh.every((r) => !r.assignment_review_required)).toBe(true);
    expect(fresh.every((r) => !r.serving_branch_id)).toBe(true);
    expect(ctx.activityLog.logChange).toHaveBeenCalledTimes(1);
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'District',
        action: ActivityAction.ASSIGN,
        metadata: { source: 'seed_auto_assign_D1' },
      }),
    );
  });
});

describe('D1: district coverage review', () => {
  it('missing_official + review_required (filial nomi, kind); faqat SA/ADMIN', async () => {
    const ctx = setup(
      [
        d('5', {
          name: "Farg'ona shahri",
          sato_code: '1730401',
          serving_branch_id: '11',
          assignment_review_required: true,
          assignment_review_reason: 'auto_assigned_D1',
          assignment_flagged_at: new Date('2026-11-14T10:00:00Z'),
        }),
        d('6', {
          name: "Qo'shtepa tumani",
          sato_code: '1730206',
          assignment_review_required: true,
          assignment_review_reason: 'no_branch_found',
        }),
        d('7', { name: 'Eski', sato_code: '1730233', isDeleted: true }),
      ],
      {},
    );
    const res = (await ctx.service.districtCoverageReview(ADMIN)) as {
      data: {
        missing_official: Row[];
        review_required: Row[];
        checked_at: string;
      };
    };
    const official = satoRegions.flatMap((r) => r.districts);
    // 2 ta tirik qator bor; o'chirilgan qator "bor" hisoblanmaydi.
    expect(res.data.missing_official).toHaveLength(official.length - 2);
    expect(res.data.missing_official).toContainEqual({
      sato_code: '1730233',
      name: expect.any(String),
      region: { id: '1', name: "Farg'ona viloyati", sato_code: '1730' },
    });
    expect(res.data.missing_official).toContainEqual(
      expect.objectContaining({
        sato_code: '1703401',
        region: { id: null, name: null, sato_code: '1703' },
      }),
    );
    expect(res.data.review_required).toEqual([
      {
        district_id: '5',
        name: "Farg'ona shahri",
        region: { id: '1', name: "Farg'ona viloyati", sato_code: '1730' },
        sato_code: '1730401',
        kind: 'city',
        serving_branch: { id: '11', name: 'Quva filiali' },
        reason: 'auto_assigned_D1',
        flagged_at: new Date('2026-11-14T10:00:00Z'),
      },
      expect.objectContaining({
        district_id: '6',
        kind: 'tuman',
        serving_branch: null,
        reason: 'no_branch_found',
      }),
    ]);
    expect(typeof res.data.checked_at).toBe('string');
    expect(
      (await rpcError(ctx.service.districtCoverageReview(MANAGER))).statusCode,
    ).toBe(403);
  });

  it('filial xizmati javob bermasa — nom null, javob baribir', async () => {
    const ctx = setup(
      [d('5', { serving_branch_id: '10', assignment_review_required: true })],
      { branches: { '10': 'down' } },
    );
    const res = (await ctx.service.districtCoverageReview(SA)) as {
      data: { review_required: Row[] };
    };
    expect(res.data.review_required[0].serving_branch).toEqual({
      id: '10',
      name: null,
    });
  });
});

describe('D1: confirm assignment', () => {
  it('belgini tushiradi, audit; ikkinchi chaqiruv idempotent (audit yo‘q)', async () => {
    const ctx = setup([
      d('5', {
        serving_branch_id: '11',
        assignment_review_required: true,
        assignment_review_reason: 'auto_assigned_D1',
      }),
    ]);
    const first = (await ctx.service.confirmDistrictAssignment('5', SA)) as {
      data: Row;
    };
    expect(first.data).toEqual({
      district_id: '5',
      assignment_review_required: false,
      confirmed_by: '7',
      confirmed_at: expect.any(Date),
    });
    const row = ctx.districtRepo.rows.get('5')!;
    expect(row.assignment_review_required).toBe(false);
    expect(row.assignment_review_reason).toBe('auto_assigned_D1');
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'District',
        entity_id: '5',
        action: ActivityAction.UPDATED,
        metadata: { source: 'confirm_assignment', reason: 'auto_assigned_D1' },
        user_id: '7',
      }),
    );
    const second = (await ctx.service.confirmDistrictAssignment(
      '5',
      ADMIN,
    )) as {
      data: Row;
    };
    expect(second.data).toMatchObject({
      assignment_review_required: false,
      confirmed_by: '7',
    });
    expect(ctx.activityLog.logChange).toHaveBeenCalledTimes(1);
  });

  it('rol, noto‘g‘ri id, yo‘q tuman', async () => {
    const ctx = setup([d('5')]);
    expect(
      (await rpcError(ctx.service.confirmDistrictAssignment('5', MANAGER)))
        .statusCode,
    ).toBe(403);
    expect(
      (await rpcError(ctx.service.confirmDistrictAssignment('abc', SA)))
        .statusCode,
    ).toBe(400);
    expect(
      (await rpcError(ctx.service.confirmDistrictAssignment('77', SA)))
        .statusCode,
    ).toBe(404);
  });
});

describe('D1: qayta biriktirish belgini tushiradi', () => {
  it('set_serving_branch — tanlangan belgili tuman (filial o‘zgarmasa ham) va o‘zgargan tuman', async () => {
    const ctx = setup([
      d('5', {
        serving_branch_id: '10',
        assignment_review_required: true,
        assignment_review_reason: 'auto_assigned_D1',
      }),
      d('6', {
        serving_branch_id: '11',
        assignment_review_required: true,
        assignment_review_reason: 'auto_assigned_D1',
      }),
      d('7', { serving_branch_id: '11', assignment_review_required: true }),
    ]);
    await ctx.service.setDistrictServingBranch('10', ['5', '6'], SA);
    const rows = ctx.districtRepo.rows;
    expect(rows.get('5')!.assignment_review_required).toBe(false);
    expect(rows.get('6')!.assignment_review_required).toBe(false);
    expect(rows.get('6')!.serving_branch_id).toBe('10');
    expect(rows.get('6')!.assignment_review_reason).toBe('auto_assigned_D1');
    expect(rows.get('6')!.assignment_confirmed_by).toBe('7');
    // Boshqa filialning tegilmagan tumani — belgi qoladi.
    expect(rows.get('7')!.assignment_review_required).toBe(true);
    const sources = ctx.activityLog.logChange.mock.calls.map(
      (c) => (c[0] as Row).metadata as Row,
    );
    expect(
      sources.filter((m) => m.source === 'cleared_by_reassign'),
    ).toHaveLength(2);
  });
});
