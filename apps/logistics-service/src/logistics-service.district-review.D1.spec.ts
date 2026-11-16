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
      const saved = {
        isDeleted: false,
        ...row,
        id: row.id ? String(row.id) : String(nextId++),
      };
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
    /** `branch.dispatch_destinations` javob bermaydi. */
    destinationsDown?: boolean;
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
        if (pattern.cmd === 'branch.dispatch_destinations') {
          if (opts.destinationsDown) {
            return throwError(() => new Error('down'));
          }
          // branch-service faqat faol REGIONAL/HYBRID qaytaradi; mock esa
          // ATAYLAB filtrlamaydi — logistics tomonidagi himoya filtri ham
          // tekshiriladi (HQ / nofaol / PICKUP chiqmasligi kerak).
          const items = Object.values(branches).filter(
            (b): b is Row => b !== 'down',
          );
          return of({ statusCode: 200, data: { items, total: items.length } });
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

  it('shahar/tuman jufti — juftning viloyati va (shu viloyatda bo‘lsa) filial ishorasi', async () => {
    const ctx = setup([
      d('1', { name: "Farg'ona", serving_branch_id: '11' }),
      d('2', { serving_branch_id: '10' }),
      d('3', { serving_branch_id: '10' }),
    ]);
    await expect(auto(ctx, "Farg'ona shahri")).resolves.toEqual({
      assigned_region: '1',
      branch_id: '11',
      reason: 'auto_assigned_D1',
    });
  });

  it('jufti boshqa viloyatga ko‘chirilgan — juftning assigned_region i, filial ko‘chirilmaydi (ko‘pchilik ham emas)', async () => {
    // Sintetik: "Yangiyo'l" tumani xizmat viloyati #2 ga ko'chirilgan, uning
    // filiali #20 — #2 viloyatniki. Yangi shahar #2 ga yo'naltiriladi,
    // #1 viloyat filiali (#10) unga yopishtirilmaydi.
    const ctx = setup([
      d('1', {
        name: "Yangiyo'l",
        assigned_region: '2',
        serving_branch_id: '20',
      }),
      d('2', { serving_branch_id: '10' }),
      d('3', { serving_branch_id: '10' }),
    ]);
    await expect(auto(ctx, "Yangiyo'l shahri")).resolves.toEqual({
      assigned_region: '2',
      branch_id: null,
      reason: 'auto_assigned_D1',
    });
  });

  it('jufti yo‘q — xizmat viloyati SHU viloyat bo‘lgan qo‘shnilarda eng ko‘p filial; teng bo‘lsa kichik id', async () => {
    let ctx = setup([
      d('1', { serving_branch_id: '11' }),
      d('2', { serving_branch_id: '10' }),
      d('3', { serving_branch_id: '10' }),
    ]);
    await expect(auto(ctx, "Qo'shtepa tumani")).resolves.toEqual({
      assigned_region: '1',
      branch_id: '10',
      reason: 'auto_assigned_D1',
    });
    ctx = setup([
      d('1', { serving_branch_id: '11' }),
      d('2', { serving_branch_id: '9' }),
    ]);
    await expect(auto(ctx, "Qo'shtepa tumani")).resolves.toEqual({
      assigned_region: '1',
      branch_id: '9',
      reason: 'auto_assigned_D1',
    });
    // Boshqa viloyatga ko'chirilgan qo'shnilar sanalmaydi.
    ctx = setup([
      d('1', { serving_branch_id: '11' }),
      d('2', { serving_branch_id: '20', assigned_region: '2' }),
      d('3', { serving_branch_id: '20', assigned_region: '2' }),
    ]);
    await expect(auto(ctx, "Qo'shtepa tumani")).resolves.toEqual({
      assigned_region: '1',
      branch_id: '11',
      reason: 'auto_assigned_D1',
    });
  });

  it('o‘chirilgan / boshqa viloyat qatorlari hisobga olinmaydi; ishora yo‘q — null (prod: ustun hamma joyda NULL)', async () => {
    const ctx = setup([
      d('1', { serving_branch_id: '10', isDeleted: true }),
      d('2', { serving_branch_id: '10', region_id: '2' }),
      d('3'),
    ]);
    await expect(auto(ctx, "Qo'shtepa tumani")).resolves.toEqual({
      assigned_region: '1',
      branch_id: null,
      reason: 'auto_assigned_D1',
    });
  });
});

describe('D1: onModuleInit seed', () => {
  it('MAVJUD viloyatga qo‘shilgan tuman — avtomatik biriktirish + belgi + audit; bor tumanlar tegilmaydi', async () => {
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
        assigned_region: '1',
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
        new_value: expect.objectContaining({ assigned_region: '1' }),
        metadata: { source: 'seed_auto_assign_D1' },
      }),
    );
  });

  it('jufti boshqa viloyatga ko‘chirilgan — yangi qator ham o‘sha viloyatga yo‘naltiriladi', async () => {
    const { regions } = jest.requireActual('./data/regions-districts.data');
    const fergana = regions.find((r: Row) => r.sato_code === '1730');
    const existing = (fergana.districts as Row[])
      .filter((x) => x.name !== "Farg'ona shahri")
      .map((x, i) =>
        d(String(i + 1), {
          name: x.name,
          sato_code: x.sato_code,
          ...(x.name === "Farg'ona"
            ? { assigned_region: '2', serving_branch_id: '20' }
            : {}),
        }),
      );
    const ctx = setup(existing, {
      regions: [
        { id: '1', name: fergana.name.trim(), sato_code: '1730' },
        { id: '2', name: 'Sintetik viloyat', sato_code: '1799' },
      ],
    });
    await ctx.service.onModuleInit();
    const added = [...ctx.districtRepo.rows.values()].find(
      (r) => r.name === "Farg'ona shahri",
    );
    expect(added).toEqual(
      expect.objectContaining({
        region_id: '1',
        assigned_region: '2',
        serving_branch_id: null,
        assignment_review_required: true,
      }),
    );
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: ActivityAction.CREATED }),
    );
  });
});

describe('D1: district coverage review', () => {
  const REGIONS = [
    { id: '1', name: "Farg'ona viloyati", sato_code: '1730' },
    { id: '2', name: 'Sintetik shahar', sato_code: '1726' },
    { id: '3', name: 'Filialsiz viloyat', sato_code: '1735' },
  ];
  const BRANCHES: Record<string, Row> = {
    '11': {
      id: '11',
      name: 'Quva filiali',
      type: 'REGIONAL',
      status: 'active',
      region_id: '1',
    },
    '10': {
      id: '10',
      name: "Farg'ona filiali",
      type: 'HYBRID',
      status: 'active',
      region_id: '1',
    },
    '12': {
      id: '12',
      name: 'Yopilgan filial',
      type: 'REGIONAL',
      status: 'inactive',
      region_id: '1',
    },
    '13': {
      id: '13',
      name: 'Pickup',
      type: 'PICKUP',
      status: 'active',
      region_id: '1',
    },
    '1': {
      id: '1',
      name: 'HQ',
      type: 'HQ',
      status: 'active',
      region_id: '3',
    },
    '20': {
      id: '20',
      name: 'Shahar filiali',
      type: 'REGIONAL',
      status: 'active',
      region_id: '2',
    },
  };
  type ReviewRes = {
    data: {
      missing_official: Row[];
      review_required: Row[];
      checked_at: string;
    };
  };

  it('missing_official + review_required: filial CHAQIRUV paytida viloyat qoidasidan; faqat SA/ADMIN', async () => {
    const ctx = setup(
      [
        // Saqlangan ishora (#11) viloyat ro'yxatida — o'sha.
        d('5', {
          name: "Farg'ona shahri",
          sato_code: '1730401',
          serving_branch_id: '11',
          assignment_review_required: true,
          assignment_review_reason: 'auto_assigned_D1',
          assignment_flagged_at: new Date('2026-11-14T10:00:00Z'),
        }),
        // Prod holati: ustun NULL — eng kichik id (#10), «filial yo'q» EMAS.
        d('6', {
          name: "Qo'shtepa tumani",
          sato_code: '1730206',
          assignment_review_required: true,
          assignment_review_reason: 'no_branch_found',
        }),
        // Eskirgan ishora (nofaol #12) — e'tiborsiz, eng kichik id.
        d('8', {
          sato_code: '1730208',
          serving_branch_id: '12',
          assignment_review_required: true,
        }),
        // Boshqa viloyatga ko'chirilgan — o'sha viloyat filiali.
        d('9', {
          sato_code: '1730209',
          assigned_region: '2',
          assignment_review_required: true,
        }),
        // Viloyatda faol REGIONAL/HYBRID yo'q (faqat HQ) — no_branch_found.
        d('10', {
          region_id: '3',
          sato_code: '1735401',
          assignment_review_required: true,
        }),
        d('7', { name: 'Eski', sato_code: '1730233', isDeleted: true }),
      ],
      { regions: REGIONS, branches: BRANCHES },
    );
    const res = (await ctx.service.districtCoverageReview(ADMIN)) as ReviewRes;
    const official = satoRegions.flatMap((r) => r.districts);
    const officialCodes = new Set(official.map((x) => x.sato_code));
    const liveOfficial = [
      '1730401',
      '1730206',
      '1730208',
      '1730209',
      '1735401',
    ].filter((c) => officialCodes.has(c)).length;
    // O'chirilgan qator "bor" hisoblanmaydi.
    expect(res.data.missing_official).toHaveLength(
      official.length - liveOfficial,
    );
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
    const fergRegion = {
      id: '1',
      name: "Farg'ona viloyati",
      sato_code: '1730',
    };
    const fergBranches = [
      { id: '10', name: "Farg'ona filiali" },
      { id: '11', name: 'Quva filiali' },
    ];
    expect(res.data.review_required).toEqual([
      {
        district_id: '5',
        name: "Farg'ona shahri",
        region: fergRegion,
        service_region: fergRegion,
        sato_code: '1730401',
        kind: 'city',
        serving_branch: { id: '11', name: 'Quva filiali' },
        region_branches: fergBranches,
        reason: 'auto_assigned_D1',
        flagged_at: new Date('2026-11-14T10:00:00Z'),
      },
      expect.objectContaining({
        district_id: '6',
        kind: 'tuman',
        serving_branch: { id: '10', name: "Farg'ona filiali" },
        region_branches: fergBranches,
        reason: 'auto_assigned_D1',
      }),
      expect.objectContaining({
        district_id: '8',
        serving_branch: { id: '10', name: "Farg'ona filiali" },
        reason: 'auto_assigned_D1',
      }),
      expect.objectContaining({
        district_id: '9',
        region: fergRegion,
        service_region: { id: '2', name: 'Sintetik shahar', sato_code: '1726' },
        serving_branch: { id: '20', name: 'Shahar filiali' },
        region_branches: [{ id: '20', name: 'Shahar filiali' }],
        reason: 'auto_assigned_D1',
      }),
      expect.objectContaining({
        district_id: '10',
        serving_branch: null,
        region_branches: [],
        reason: 'no_branch_found',
      }),
    ]);
    expect(typeof res.data.checked_at).toBe('string');
    // Saqlangan ustunlar tegilmaydi (faqat o'qish).
    expect(ctx.districtRepo.rows.get('6')!.serving_branch_id).toBeNull();
    expect(ctx.districtRepo.update).not.toHaveBeenCalled();
    expect(
      (await rpcError(ctx.service.districtCoverageReview(MANAGER))).statusCode,
    ).toBe(403);
  });

  it('filial xizmati javob bermasa — 503 (qamrov tekshiruvlari bilan bir xil), «filial yo‘q» deb ko‘rsatilmaydi', async () => {
    const ctx = setup(
      [d('5', { serving_branch_id: '10', assignment_review_required: true })],
      { destinationsDown: true },
    );
    expect(
      (await rpcError(ctx.service.districtCoverageReview(SA))).statusCode,
    ).toBe(503);
  });

  it('belgili tuman yo‘q — filial xizmati chaqirilmaydi', async () => {
    const ctx = setup([d('5')], { destinationsDown: true });
    const res = (await ctx.service.districtCoverageReview(SA)) as ReviewRes;
    expect(res.data.review_required).toEqual([]);
    expect(ctx.branchClient.send).not.toHaveBeenCalled();
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

  it('poyga: ikki parallel tasdiq — bitta audit, ikkalasi ham yutgan yozuvni qaytaradi', async () => {
    const ctx = setup([
      d('5', {
        assignment_review_required: true,
        assignment_review_reason: 'auto_assigned_D1',
      }),
    ]);
    const [a, b] = (await Promise.all([
      ctx.service.confirmDistrictAssignment('5', SA),
      ctx.service.confirmDistrictAssignment('5', ADMIN),
    ])) as Array<{ data: Row }>;
    expect(ctx.activityLog.logChange).toHaveBeenCalledTimes(1);
    const winner = ctx.districtRepo.rows.get('5')!;
    for (const res of [a, b]) {
      expect(res.data).toEqual({
        district_id: '5',
        assignment_review_required: false,
        confirmed_by: winner.assignment_confirmed_by,
        confirmed_at: winner.assignment_confirmed_at,
      });
    }
  });

  it('poyga: tasdiq qayta biriktirishdan keyin yetib keldi — audit yo‘q, saqlangan confirmed_by/at', async () => {
    const ctx = setup([
      d('5', {
        assignment_review_required: true,
        assignment_review_reason: 'auto_assigned_D1',
      }),
    ]);
    // findOne (o'qish) belgili qatorni ko'rdi; UPDATE'gacha boshqa admin
    // viloyatni o'zgartirib belgini tushirdi.
    const confirmedAt = new Date('2026-11-15T08:00:00Z');
    ctx.districtRepo.findOne.mockImplementationOnce(() => {
      const snapshot = { ...ctx.districtRepo.rows.get('5')! };
      Object.assign(ctx.districtRepo.rows.get('5')!, {
        assignment_review_required: false,
        assignment_confirmed_by: '8',
        assignment_confirmed_at: confirmedAt,
      });
      return Promise.resolve(snapshot);
    });
    const res = (await ctx.service.confirmDistrictAssignment('5', SA)) as {
      data: Row;
    };
    expect(res.data).toEqual({
      district_id: '5',
      assignment_review_required: false,
      confirmed_by: '8',
      confirmed_at: confirmedAt,
    });
    expect(ctx.activityLog.logChange).not.toHaveBeenCalled();
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

  it('PATCH /district/:id (updateDistrict) — viloyat o‘zgarsa belgi SHU saqlashda tushadi (audit cleared_by_region_move)', async () => {
    const ctx = setup(
      [
        d('5', {
          assigned_region: '1',
          assignment_review_required: true,
          assignment_review_reason: 'auto_assigned_D1',
        }),
        d('6', { assigned_region: '1' }),
      ],
      {
        regions: [
          { id: '1', name: "Farg'ona viloyati", sato_code: '1730' },
          { id: '2', name: 'Sintetik viloyat', sato_code: '1799' },
        ],
      },
    );
    await ctx.service.updateDistrict('5', { assigned_region: '2' } as any, SA);
    expect(ctx.districtRepo.save).toHaveBeenCalledTimes(1);
    const row = ctx.districtRepo.rows.get('5')!;
    expect(row).toMatchObject({
      assigned_region: '2',
      assignment_review_required: false,
      assignment_review_reason: 'auto_assigned_D1',
      assignment_confirmed_by: '7',
      assignment_confirmed_at: expect.any(Date),
    });
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '5',
        old_value: { assignment_review_required: true },
        metadata: {
          source: 'cleared_by_region_move',
          reason: 'auto_assigned_D1',
        },
        user_id: '7',
      }),
    );

    // Belgisiz tuman — belgi audit'i yo'q.
    ctx.activityLog.logChange.mockClear();
    await ctx.service.updateDistrict('6', { assigned_region: '2' } as any, SA);
    expect(ctx.districtRepo.rows.get('6')!.assignment_confirmed_by).toBeNull();
    expect(
      ctx.activityLog.logChange.mock.calls.filter(
        (c) =>
          ((c[0] as Row).metadata as Row | undefined)?.source ===
          'cleared_by_region_move',
      ),
    ).toHaveLength(0);
  });

  it('clear_serving_branch — filial bo‘shatiladi, belgi QOLADI (tekshiruv baribir kerak)', async () => {
    const ctx = setup([
      d('5', {
        serving_branch_id: '10',
        assignment_review_required: true,
        assignment_review_reason: 'auto_assigned_D1',
      }),
    ]);
    await ctx.service.clearDistrictServingBranch('10');
    const row = ctx.districtRepo.rows.get('5')!;
    expect(row.serving_branch_id).toBeNull();
    expect(row.assignment_review_required).toBe(true);
  });
});
