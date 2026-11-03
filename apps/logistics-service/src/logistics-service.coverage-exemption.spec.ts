/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { RpcException } from '@nestjs/microservices';
import { FindOperator } from 'typeorm';
import { of, throwError, type Observable } from 'rxjs';
import { ActivityAction, Order_status } from '@app/common';
import {
  COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE,
  LogisticsServiceService,
} from './logistics-service.service';
import type { OpenCustodyRow } from './coverage/district-coverage-exemption';

/**
 * Tuman qamrovi IMTIYOZLARI (ega qarori, 2026-11-02): tuman ko'chirilganda
 * shu paytda eski filial yoki uning kuryeri qo'lidagi ochiq buyurtmalar eski
 * filialda tugaydi. Viloyat qoidasidan (anKpzwxk, 2026-11-03) beri imtiyoz
 * faqat tumanning XIZMAT VILOYATI o'zgarganda paydo bo'ladi;
 * `serving_branch_id` almashishi (setDistrictServingBranch /
 * clearDistrictServingBranch) qamrovni o'zgartirmaydi — imtiyoz yo'q.
 *
 *  - snapshot: `order.open_custody_by_district` sahifalab o'qiladi (≤ 50
 *    tuman bo'lagi, `next_after_id`, sahifa chegarasi), xato — 503 va tuman
 *    o'zgarmaydi;
 *  - updateDistrict / setDistrictServingBranch / clearDistrictServingBranch
 *    (best-effort) / mergeDistricts ko'chishdan OLDIN imtiyoz yozadi va
 *    ko'chish COMMIT bo'lgach QAYTA yozadi (best-effort; oraliqda custody'ga
 *    kirganlar ham); imtiyozda ko'chishdan keyingi tuman saqlanadi;
 *  - yo'ldagi (SENT) partiya — borayotgan filialniki;
 *  - assertOrdersServedByBranch: imtiyozli buyurtma eski filial kuryeriga
 *    beriladi (kuryer qaytargach ham), faqat buyurtma hozir imtiyoz
 *    tumanida bo'lsa; qolganlari — 403.
 *
 * Imtiyoz jadvali xotirada: `INSERT … ON CONFLICT DO UPDATE … WHERE`
 * (unnest parametrlari) va `find` (In / IsNull) talqin qilinadi.
 */
type Row = Record<string, unknown>;

const SA = { id: '1', roles: ['superadmin'] };

// ---------------------------------------------------------------- yordamchilar

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
    if (cond.type === 'isNull') {
      return value === null || value === undefined;
    }
    throw new Error(`Qo'llab-quvvatlanmagan operator: ${cond.type}`);
  }
  return value === cond;
};

const matchesWhere = (row: Row, where: Row | Row[]): boolean =>
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([key, cond]) => matchValue(row[key], cond)),
  );

type ExemptionRow = {
  order_id: string;
  branch_id: string;
  district_id: string | null;
  source: string;
  revoked_at: Date | null;
};

function exemptionRepoOf(
  initial: Array<
    Partial<ExemptionRow> & { order_id: string; branch_id: string }
  > = [],
) {
  const rows: ExemptionRow[] = initial.map((row) => ({
    district_id: null,
    source: 'seed',
    revoked_at: null,
    ...row,
  }));
  const failing = new Set<'INSERT' | 'UPDATE' | 'DELETE'>();
  const query = jest.fn((sql: string, params: unknown[]) => {
    const statement = sql.trim();
    const kind = statement.startsWith('UPDATE')
      ? 'UPDATE'
      : statement.startsWith('DELETE')
        ? 'DELETE'
        : 'INSERT';
    if (failing.has(kind)) {
      return Promise.reject(new Error('DB yiqildi'));
    }
    if (kind === 'UPDATE') {
      // coverageExemptionRetargetQuery: A tumanli qatorlar (faqat shu
      // buyurtmalar) B ga.
      const [fromId, toId, orderIds] = params as [string, string, string[]];
      const changed = rows.filter(
        (row) => row.district_id === fromId && orderIds.includes(row.order_id),
      );
      for (const row of changed) row.district_id = toId;
      return Promise.resolve(
        changed.map((row) => ({ order_id: row.order_id })),
      );
    }
    if (kind === 'DELETE') {
      // coverageExemptionDeleteQuery: juftlar + tuman + manba.
      const [orderIds, branchIds, districtId, source] = params as [
        string[],
        string[],
        string,
        string,
      ];
      const removed: Row[] = [];
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        const paired = orderIds.some(
          (orderId, at) =>
            orderId === row.order_id && branchIds[at] === row.branch_id,
        );
        if (paired && row.district_id === districtId && row.source === source) {
          removed.push({ order_id: row.order_id });
          rows.splice(index, 1);
        }
      }
      return Promise.resolve(removed);
    }
    expect(sql).toContain('ON CONFLICT ("order_id", "branch_id") DO UPDATE');
    const [orderIds, branchIds, districtIds, source] = params as [
      string[],
      string[],
      Array<string | null>,
      string,
    ];
    const created: Row[] = [];
    orderIds.forEach((orderId, index) => {
      const branchId = branchIds[index];
      const existing = rows.find(
        (row) => row.order_id === orderId && row.branch_id === branchId,
      );
      if (existing) {
        // DO UPDATE … WHERE tuman boshqacha yoki bekor qilingan.
        if (
          existing.district_id !== districtIds[index] ||
          existing.revoked_at !== null
        ) {
          existing.district_id = districtIds[index];
          existing.revoked_at = null;
          existing.source = source;
          created.push({
            order_id: orderId,
            branch_id: branchId,
            district_id: districtIds[index],
          });
        }
        return;
      }
      rows.push({
        order_id: orderId,
        branch_id: branchId,
        district_id: districtIds[index],
        source,
        revoked_at: null,
      });
      created.push({
        order_id: orderId,
        branch_id: branchId,
        district_id: districtIds[index],
      });
    });
    return Promise.resolve(created);
  });
  return {
    rows,
    failInserts: () => {
      failing.add('INSERT');
    },
    /** Qayta yo'naltirish (UPDATE) / o'chirish (DELETE) so'rovi yiqiladi. */
    failQueries: (kind: 'UPDATE' | 'DELETE') => {
      failing.add(kind);
    },
    find: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        rows
          .filter((row) => matchesWhere(row as unknown as Row, where))
          .map((row) => ({
            order_id: row.order_id,
            district_id: row.district_id,
          })),
      ),
    ),
    manager: { query },
  };
}

type ExemptionRepo = ReturnType<typeof exemptionRepoOf>;

type DistrictRow = {
  id: string;
  name: string;
  region_id: string;
  assigned_region: string | null;
  serving_branch_id: string | null;
};

const district = (overrides: Partial<DistrictRow> & { id: string }) => ({
  name: `Tuman ${overrides.id}`,
  region_id: '1',
  assigned_region: null,
  serving_branch_id: null,
  ...overrides,
});

/**
 * Tuman repo xotirada. Tranzaksiya: xato bo'lsa tumanlar va imtiyozlar
 * avvalgi holatiga qaytadi (rollback); tranzaksiya menejeri `query` ni
 * imtiyoz jadvaliga yo'naltiradi.
 */
function districtRepoOf(initial: DistrictRow[], exemptions: ExemptionRepo) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const repo = {
    rows,
    /** COMMIT bo'lgan (callback xatosiz tugagan) tranzaksiyalar soni. */
    commits: 0,
    find: jest.fn(({ where }: { where: Row | Row[] }) =>
      Promise.resolve(
        Array.from(rows.values())
          .filter((row) => matchesWhere(row, where))
          .map((row) => ({ ...row })),
      ),
    ),
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        rows.has(String(where.id)) ? { ...rows.get(String(where.id)) } : null,
      ),
    ),
    save: jest.fn((entity: Row) => {
      const plain = { ...entity };
      delete plain.assignedToRegion;
      rows.set(String(entity.id), plain as unknown as DistrictRow);
      return Promise.resolve({ ...entity });
    }),
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
      transaction: jest.fn(async (cb: (manager: unknown) => unknown) => {
        const districtsBefore = new Map(
          Array.from(rows.entries()).map(([id, row]) => [id, { ...row }]),
        );
        const exemptionsBefore = exemptions.rows.length;
        try {
          const result = await cb({
            getRepository: (): unknown => repo,
            query: exemptions.manager.query,
            remove: jest.fn((entity: Row) => {
              rows.delete(String(entity.id));
              return Promise.resolve(entity);
            }),
          });
          repo.commits += 1;
          return result;
        } catch (error) {
          rows.clear();
          for (const [id, row] of districtsBefore) rows.set(id, row);
          exemptions.rows.splice(exemptionsBefore);
          throw error;
        }
      }),
    },
  };
  return repo;
}

type BranchReply = Row | null | 'down';

const branch = (id: string, overrides: Row = {}): Row => ({
  id,
  type: 'REGIONAL',
  region_id: '1',
  status: 'active',
  ...overrides,
});

/** Viloyat 1: filiallar 10 (P) va 11 (B); viloyat 2: 20; HQ — 1. */
const BRANCHES: Record<string, BranchReply> = {
  '1': branch('1', { type: 'HQ' }),
  '10': branch('10'),
  '11': branch('11'),
  '20': branch('20', { region_id: '2' }),
};

function branchClientOf(
  branches: Record<string, BranchReply> = BRANCHES,
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
        if (pattern.cmd === 'branch.geo_usage') {
          return of({ data: { branches: 0 } });
        }
        if (pattern.cmd === 'branch.reassign_district') {
          return of({ data: { ids: [] } });
        }
        return of({ data: null });
      },
    ),
  };
}

const custodyRow = (
  overrides: Partial<OpenCustodyRow> & { id: string },
): OpenCustodyRow => ({
  district_id: '5',
  region_id: '1',
  status: Order_status.RECEIVED,
  holder_type: 'BRANCH',
  holder_branch_id: '10',
  holder_courier_id: null,
  branch_id: '10',
  courier_id: null,
  current_batch_id: null,
  batch_destination_branch_id: null,
  ...overrides,
});

/**
 * `rows` rejimi: `afterFirstRead` — birinchi custody o'qilgandan keyin bir
 * marta (snapshot va ko'chish orasidagi oyna: buyurtma custody'ga kirdi);
 * `failAfter` — shuncha o'qishdan keyingilari yiqiladi (qayta snapshot
 * xatosi). Birlashtirish: `order.geo.reassign_district` qatorlarni A dan B
 * ga ko'chiradi va id'larini qaytaradi, `order.geo.usage` — qatorlar soni.
 */
type CustodyRows = {
  rows: OpenCustodyRow[];
  pageSize?: number;
  afterFirstRead?: (rows: OpenCustodyRow[]) => void;
  failAfter?: number;
};

type CustodyMode =
  CustodyRows | 'down' | ((payload: Row) => Observable<unknown>);

/** Custody o'qilgan paytdagi tuman repo holati. */
type CustodyReadState = { commits: number; districts: string[] };

/**
 * order-service shartnomasi: `district_ids` dagi qatorlar, `id > after_id`,
 * id bo'yicha tartib, `limit` (yoki mock sahifa hajmi); sahifa to'lsa
 * `next_after_id` — oxirgi id.
 */
function orderClientOf(
  custody: CustodyMode,
  orders: Map<string, Row> = new Map(),
  stateOf: () => CustodyReadState = () => ({ commits: 0, districts: [] }),
) {
  let reads = 0;
  /** Har custody o'qilgan paytdagi holat (COMMIT'lar, mavjud tumanlar). */
  const custodyReads: CustodyReadState[] = [];
  return {
    custodyReads,
    send: jest.fn(
      (pattern: { cmd: string }, payload: Row): Observable<unknown> => {
        if (pattern.cmd === 'order.open_custody_by_district') {
          custodyReads.push(stateOf());
          if (custody === 'down') {
            return throwError(() => new Error('order-service down'));
          }
          if (typeof custody === 'function') {
            return custody(payload);
          }
          reads += 1;
          if (custody.failAfter !== undefined && reads > custody.failAfter) {
            return throwError(() => new Error('order-service down'));
          }
          const ids = (payload.district_ids as string[]).map(String);
          const afterId =
            typeof payload.after_id === 'string'
              ? BigInt(payload.after_id)
              : null;
          const limit = Math.min(
            Number(payload.limit ?? 1000),
            custody.pageSize ?? 1000,
          );
          const rows = custody.rows
            .filter((row) => ids.includes(String(row.district_id)))
            .filter((row) => afterId === null || BigInt(row.id) > afterId)
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
            .slice(0, limit)
            .map((row) => ({ ...row }));
          if (reads === 1 && custody.afterFirstRead) {
            custody.afterFirstRead(custody.rows);
          }
          return of({
            statusCode: 200,
            message: 'success',
            data: {
              rows,
              next_after_id:
                rows.length === limit ? rows[rows.length - 1].id : null,
            },
          });
        }
        if (pattern.cmd === 'order.find_by_id') {
          return of(orders.get(String(payload.id)));
        }
        if (pattern.cmd === 'order.geo.usage') {
          const orders =
            typeof custody === 'object'
              ? custody.rows.filter(
                  (row) => row.district_id === String(payload.district_id),
                ).length
              : 0;
          return of({ data: { orders } });
        }
        if (pattern.cmd === 'order.geo.reassign_district') {
          // Kompensatsiya `ids` bilan — faqat o'shalar qaytadi.
          const onlyIds = Array.isArray(payload.ids)
            ? (payload.ids as unknown[]).map(String)
            : null;
          const moved =
            typeof custody === 'object'
              ? custody.rows.filter(
                  (row) =>
                    row.district_id === String(payload.from_district_id) &&
                    (onlyIds === null || onlyIds.includes(row.id)),
                )
              : [];
          for (const row of moved) {
            row.district_id = String(payload.to_district_id);
          }
          return of({
            data: {
              ids: moved.map((row) => row.id),
              moved_live: moved.length,
            },
          });
        }
        return of({ statusCode: 200 });
      },
    ),
  };
}

type OrderClient = ReturnType<typeof orderClientOf>;

const custodyCalls = (orderClient: OrderClient) =>
  orderClient.send.mock.calls.filter(
    ([pattern]) => pattern.cmd === 'order.open_custody_by_district',
  );

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

async function ok<T = Row>(
  promise: Promise<unknown>,
): Promise<{ statusCode: number; data: T }> {
  return (await promise) as { statusCode: number; data: T };
}

/** Tuman amallari uchun servis (imtiyoz repo ulangan). */
function districtSetup(options: {
  districts: DistrictRow[];
  custody: CustodyMode;
  branches?: Record<string, BranchReply>;
  exemptions?: ExemptionRepo;
  regions?: Record<string, Row>;
}) {
  const exemptions = options.exemptions ?? exemptionRepoOf();
  const districtRepo = districtRepoOf(options.districts, exemptions);
  const orderClient = orderClientOf(options.custody, new Map(), () => ({
    commits: districtRepo.commits,
    districts: Array.from(districtRepo.rows.keys()),
  }));
  const branchClient = branchClientOf(options.branches ?? BRANCHES);
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }): Observable<unknown> =>
      pattern.cmd === 'identity.user.geo_usage'
        ? of({ data: { users: 0 } })
        : of({ data: { ids: [] } }),
    ),
  };
  const regions = options.regions ?? {
    '1': { id: '1', name: 'Toshkent' },
    '2': { id: '2', name: 'Namangan' },
  };
  const regionRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(regions[String(where.id)] ?? null),
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
    orderClient as any,
    branchClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
    activityLog as any,
    undefined,
    exemptions as any,
  );
  const logger = (service as unknown as { logger: { error: jest.Mock } })
    .logger;
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const pairs = () =>
    exemptions.rows.map((row) => `${row.order_id}@${row.branch_id}`).sort();
  return {
    service,
    districtRepo,
    orderClient,
    branchClient,
    identityClient,
    activityLog,
    exemptions,
    logger,
    pairs,
  };
}

// --------------------------------------------------------------- snapshot

describe('snapshotCoverageExemptions — custody sahifalash va fail-closed', () => {
  type Snapshot = (input: {
    moves: Array<{ district_id: string; before: Row; after: Row }>;
    source: string;
  }) => Promise<unknown>;
  const snapshotOf = (service: LogisticsServiceService): Snapshot =>
    (
      service as unknown as { snapshotCoverageExemptions: Snapshot }
    ).snapshotCoverageExemptions.bind(service);

  // Tumanning xizmat viloyati 1 → 2 (viloyat qoidasi: imtiyoz faqat shunda).
  const moveRegion1_to_2 = (districtId = '5') => ({
    district_id: districtId,
    before: district({ id: districtId }),
    after: district({ id: districtId, assigned_region: '2' }),
  });

  it('⭐ ko‘p sahifa: next_after_id bo‘yicha oxirigacha o‘qiladi, hammasi yoziladi', async () => {
    const rows = ['101', '102', '103', '104', '105'].map((id) =>
      custodyRow({ id }),
    );
    const ctx = districtSetup({
      districts: [],
      custody: { rows, pageSize: 2 },
    });

    const created = await snapshotOf(ctx.service)({
      moves: [moveRegion1_to_2()],
      source: 'district_update',
    });

    expect(created).toHaveLength(5);
    expect(ctx.pairs()).toEqual([
      '101@10',
      '102@10',
      '103@10',
      '104@10',
      '105@10',
    ]);
    // 2 + 2 + 1 — uchinchi sahifa to'lmadi (next_after_id null).
    expect(custodyCalls(ctx.orderClient).map(([, payload]) => payload)).toEqual(
      [
        { district_ids: ['5'], after_id: null, limit: 1000 },
        { district_ids: ['5'], after_id: '102', limit: 1000 },
        { district_ids: ['5'], after_id: '104', limit: 1000 },
      ],
    );
    // Filial qatori bir marta (tizim so'rovchisi bilan).
    expect(
      ctx.branchClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'branch.find_by_id',
      ),
    ).toEqual([
      [
        { cmd: 'branch.find_by_id' },
        { id: '10', requester: { id: 'system', roles: ['superadmin'] } },
      ],
    ]);
  });

  it('qayta yurgizish — ON CONFLICT: yangi qator yo‘q, xato ham yo‘q', async () => {
    const ctx = districtSetup({
      districts: [],
      custody: { rows: [custodyRow({ id: '101' })] },
    });
    const snapshot = snapshotOf(ctx.service);

    expect(
      await snapshot({
        moves: [moveRegion1_to_2()],
        source: 'district_update',
      }),
    ).toHaveLength(1);
    expect(
      await snapshot({
        moves: [moveRegion1_to_2()],
        source: 'district_update',
      }),
    ).toEqual([]);
    expect(ctx.exemptions.rows).toHaveLength(1);
  });

  it('51 tuman — 50 + 1 bo‘lakda so‘raladi', async () => {
    const ctx = districtSetup({ districts: [], custody: { rows: [] } });
    const moves = Array.from({ length: 51 }, (_, index) =>
      moveRegion1_to_2(String(index + 1)),
    );

    await snapshotOf(ctx.service)({ moves, source: 'district_update' });

    const sizes = custodyCalls(ctx.orderClient).map(
      ([, payload]) => (payload.district_ids as string[]).length,
    );
    expect(sizes).toEqual([50, 1]);
  });

  it.each([
    ['order-service javob bermadi', 'down' as const],
    ['noto‘g‘ri javob', () => of({ statusCode: 200, data: { rows: 'x' } })],
    ['xato statusi', () => of({ statusCode: 500, data: null })],
    [
      'sahifa oldinga siljimaydi',
      () =>
        of({
          statusCode: 200,
          data: { rows: [custodyRow({ id: '7' })], next_after_id: '7' },
        }),
    ],
  ] as Array<[string, CustodyMode]>)(
    '⭐ %s — 503, hech narsa yozilmaydi',
    async (_label, custody) => {
      const ctx = districtSetup({ districts: [], custody });

      const error = await rpcError(
        snapshotOf(ctx.service)({
          moves: [moveRegion1_to_2()],
          source: 'district_update',
        }),
      );

      expect(error.statusCode).toBe(503);
      expect(error.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);
      expect(ctx.exemptions.rows).toHaveLength(0);
      expect(ctx.exemptions.manager.query).not.toHaveBeenCalled();
    },
  );

  it('sahifalar chegarasi (100) — 503', async () => {
    let next = 0;
    const ctx = districtSetup({
      districts: [],
      custody: () => {
        next += 1;
        return of({
          statusCode: 200,
          data: {
            rows: [custodyRow({ id: String(next) })],
            next_after_id: String(next),
          },
        });
      },
    });

    const error = await rpcError(
      snapshotOf(ctx.service)({
        moves: [moveRegion1_to_2()],
        source: 'district_update',
      }),
    );

    expect(error.statusCode).toBe(503);
    expect(custodyCalls(ctx.orderClient)).toHaveLength(100);
    expect(ctx.exemptions.rows).toHaveLength(0);
  });

  it('filial xizmati javob bermadi — 503; filial topilmadi (404) — imtiyozsiz', async () => {
    const down = districtSetup({
      districts: [],
      custody: { rows: [custodyRow({ id: '101' })] },
      branches: { ...BRANCHES, '10': 'down' },
    });
    const error = await rpcError(
      snapshotOf(down.service)({
        moves: [moveRegion1_to_2()],
        source: 'district_update',
      }),
    );
    expect(error.statusCode).toBe(503);
    expect(error.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);

    const unknown = districtSetup({
      districts: [],
      custody: { rows: [custodyRow({ id: '101' })] },
      branches: { ...BRANCHES, '10': null },
    });
    expect(
      await snapshotOf(unknown.service)({
        moves: [moveRegion1_to_2()],
        source: 'district_update',
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------- updateDistrict

describe('updateDistrict — viloyat ko‘chishida imtiyoz (tuman saqlanishidan OLDIN)', () => {
  const rows = [
    // Filial 10 qo'lida (WAITING) va 11 kuryerida; 20 (viloyat 2), HQ, MARKET.
    custodyRow({ id: '101', status: Order_status.WAITING }),
    custodyRow({
      id: '102',
      status: Order_status.ON_THE_ROAD,
      holder_type: 'COURIER',
      holder_branch_id: '11',
      holder_courier_id: '45',
      courier_id: '45',
      branch_id: '11',
    }),
    custodyRow({ id: '103', holder_branch_id: '20', branch_id: '20' }),
    custodyRow({
      id: '104',
      holder_type: 'HQ',
      holder_branch_id: null,
      branch_id: '1',
    }),
    custodyRow({
      id: '105',
      holder_type: 'MARKET',
      holder_branch_id: null,
      branch_id: '10',
    }),
  ];

  it('⭐ AC6 «Eski filialda tugasin»: xizmat filiali bor edi (10) — eski viloyatning BARCHA filiallari (10, 11) imtiyozli; javob va auditda', async () => {
    // Viloyat qoidasi (anKpzwxk): serving_branch_id hisobga olinmaydi —
    // avval faqat 10 imtiyoz olardi.
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: { rows },
    });

    const res = await ok(
      ctx.service.updateDistrict('5', { assigned_region: '2' }, SA),
    );

    expect(ctx.pairs()).toEqual(['101@10', '102@11']);
    expect(ctx.exemptions.rows[0]).toMatchObject({
      district_id: '5',
      source: 'district_update',
      revoked_at: null,
    });
    expect(res.data).toMatchObject({
      assigned_region: '2',
      serving_branch_id: null,
      serving_branch_cleared: true,
      coverage_exemptions: {
        created: 2,
        by_branch: [
          { branch_id: '10', count: 1 },
          { branch_id: '11', count: 1 },
        ],
      },
    });
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'District',
        entity_id: '5',
        action: ActivityAction.UPDATED,
        new_value: {
          assigned_region: '2',
          serving_branch_id: null,
          serving_branch_cleared: true,
          coverage_exemptions: {
            created: 2,
            by_branch: [
              { branch_id: '10', count: 1 },
              { branch_id: '11', count: 1 },
            ],
          },
        },
      }),
    );
    // Imtiyoz tuman saqlanishidan OLDIN yozildi.
    expect(
      ctx.exemptions.manager.query.mock.invocationCallOrder[0],
    ).toBeLessThan(ctx.districtRepo.save.mock.invocationCallOrder[0]);
  });

  it('⭐ xizmat filialisiz: eski viloyatning ikkala filiali (10, 11) imtiyozli; 20, HQ, MARKET — yo‘q', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '5' })],
      custody: { rows },
    });

    const res = await ok(
      ctx.service.updateDistrict('5', { assigned_region: '2' }, SA),
    );

    expect(ctx.pairs()).toEqual(['101@10', '102@11']);
    expect(res.data.coverage_exemptions).toEqual({
      created: 2,
      by_branch: [
        { branch_id: '10', count: 1 },
        { branch_id: '11', count: 1 },
      ],
    });
  });

  it('⭐ fail closed: custody o‘qilmadi — 503, tuman O‘ZGARMAYDI, audit yo‘q', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: 'down',
    });

    const error = await rpcError(
      ctx.service.updateDistrict('5', { assigned_region: '2' }, SA),
    );

    expect(error.statusCode).toBe(503);
    expect(error.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);
    expect(ctx.districtRepo.save).not.toHaveBeenCalled();
    expect(ctx.districtRepo.rows.get('5')).toMatchObject({
      assigned_region: null,
      serving_branch_id: '10',
    });
    expect(ctx.activityLog.logChange).not.toHaveBeenCalled();
  });

  // Viloyat qoidasi (anKpzwxk): imtiyoz yozuvchi faqat viloyat ko'chishlari
  // (updateDistrict, mergeDistricts) — INSERT xatosining fail-closed yo'li
  // shu yerda qoplanadi (avval setDistrictServingBranch'da edi).
  it('⭐ fail closed: imtiyoz yozish (INSERT) yiqildi — 503, tuman O‘ZGARMAYDI, audit yo‘q', async () => {
    const exemptions = exemptionRepoOf();
    exemptions.failInserts();
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: { rows },
      exemptions,
    });

    const error = await rpcError(
      ctx.service.updateDistrict('5', { assigned_region: '2' }, SA),
    );

    expect(error.statusCode).toBe(503);
    expect(error.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);
    // INSERT haqiqatan chaqirildi (10 va 11 imtiyozlari) va yiqildi.
    expect(ctx.exemptions.manager.query).toHaveBeenCalledTimes(1);
    expect(ctx.exemptions.rows).toHaveLength(0);
    expect(ctx.districtRepo.save).not.toHaveBeenCalled();
    expect(ctx.districtRepo.rows.get('5')).toMatchObject({
      assigned_region: null,
      serving_branch_id: '10',
    });
    expect(ctx.activityLog.logChange).not.toHaveBeenCalled();
  });

  it('xizmat viloyati amalda o‘zgarmadi (assigned_region = region_id) — custody so‘ralmaydi', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: 'down',
    });

    const res = await ok(
      ctx.service.updateDistrict('5', { assigned_region: '1' }, SA),
    );

    expect(res.statusCode).toBe(200);
    expect(custodyCalls(ctx.orderClient)).toHaveLength(0);
    expect(res.data).not.toHaveProperty('coverage_exemptions');
  });

  it('⭐ yo‘ldagi partiyalar: HQ → 10 FORWARD — 10 ga imtiyoz; 10 → HQ — yo‘q; jo‘natilmagan (PENDING) — 10 da', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: {
        rows: [
          // HQ → 10 FORWARD partiyasi yo'lda: custody hali HQ da.
          custodyRow({
            id: '601',
            status: Order_status.ON_THE_ROAD,
            holder_type: 'HQ',
            holder_branch_id: null,
            branch_id: '1',
            current_batch_id: '900',
            batch_destination_branch_id: '10',
          }),
          // 10 → HQ partiyasi yo'lda: buyurtma HQ niki bo'ladi.
          custodyRow({
            id: '602',
            status: Order_status.WAITING,
            current_batch_id: '901',
            batch_destination_branch_id: '1',
          }),
          // PENDING partiya (hali jo'natilmagan): order-service null beradi.
          custodyRow({
            id: '603',
            status: Order_status.WAITING,
            current_batch_id: '902',
            batch_destination_branch_id: null,
          }),
        ],
      },
    });

    await ok(ctx.service.updateDistrict('5', { assigned_region: '2' }, SA));

    expect(ctx.pairs()).toEqual(['601@10', '603@10']);
  });

  it('⭐ saqlangach qayta snapshot: oraliqda 10 custody‘siga kirgan buyurtma ham imtiyozli, son ikkala yurishdan', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: {
        rows: [custodyRow({ id: '101' })],
        // Snapshot va saqlash orasida 102 filial 10 ga qabul qilindi.
        afterFirstRead: (rows) => {
          rows.push(custodyRow({ id: '102' }));
        },
      },
    });

    const res = await ok(
      ctx.service.updateDistrict('5', { assigned_region: '2' }, SA),
    );

    expect(ctx.pairs()).toEqual(['101@10', '102@10']);
    expect(res.data.coverage_exemptions).toEqual({
      created: 2,
      by_branch: [{ branch_id: '10', count: 2 }],
    });
    // Ikkinchi o'qish — tuman SAQLANGANDAN keyin.
    const custodyOrders = ctx.orderClient.send.mock.calls
      .map(([pattern], index) => ({
        cmd: pattern.cmd,
        order: ctx.orderClient.send.mock.invocationCallOrder[index],
      }))
      .filter(({ cmd }) => cmd === 'order.open_custody_by_district')
      .map(({ order }) => order);
    expect(custodyOrders).toHaveLength(2);
    expect(custodyOrders[1]).toBeGreaterThan(
      ctx.districtRepo.save.mock.invocationCallOrder[0],
    );
  });

  it('⭐ qayta snapshot yiqildi — so‘rov muvaffaqiyatli, ERROR log (tuman id bilan), son — oldingi', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: { rows: [custodyRow({ id: '101' })], failAfter: 1 },
    });

    const res = await ok(
      ctx.service.updateDistrict('5', { assigned_region: '2' }, SA),
    );

    expect(res.statusCode).toBe(200);
    expect(ctx.districtRepo.rows.get('5')?.assigned_region).toBe('2');
    expect(res.data.coverage_exemptions).toEqual({
      created: 1,
      by_branch: [{ branch_id: '10', count: 1 }],
    });
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('updateDistrict: tuman(lar) #5'),
    );
  });

  it('ikkinchi ko‘chish: mavjud (buyurtma, filial) qatori yangi tumanga qayta yo‘naltiriladi va tiklanadi', async () => {
    const exemptions = exemptionRepoOf([
      {
        order_id: '101',
        branch_id: '10',
        district_id: '4',
        revoked_at: new Date(),
      },
    ]);
    const ctx = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: { rows: [custodyRow({ id: '101' })] },
      exemptions,
    });

    const res = await ok(
      ctx.service.updateDistrict('5', { assigned_region: '2' }, SA),
    );

    expect(exemptions.rows).toEqual([
      {
        order_id: '101',
        branch_id: '10',
        district_id: '5',
        source: 'district_update',
        revoked_at: null,
      },
    ]);
    // Qayta snapshot aynan bir xil qatorga tegmaydi — son 1.
    expect(res.data.coverage_exemptions).toEqual({
      created: 1,
      by_branch: [{ branch_id: '10', count: 1 }],
    });
  });
});

// ------------------------------------------------------ setDistrictServingBranch

describe('setDistrictServingBranch — viloyat qoidasida xizmat filiali almashishi imtiyoz BERMAYDI', () => {
  // Viloyat qoidasi (anKpzwxk, 2026-11-03): `serving_branch_id` qamrovga
  // ta'sir qilmaydi — bir viloyatdagi barcha filiallar (10, 11) ko'chishdan
  // oldin ham, keyin ham xizmat qiladi. Avval (#617) bu holatlarda yo'qotgan
  // filialga imtiyoz yozilardi; endi custody o'qilsa ham imtiyoz yo'q.
  it('⭐ ko‘chdi (11 → 10) va biriktirildi (null → 10): imtiyoz YO‘Q (avval 11 ga 2 ta edi)', async () => {
    const ctx = districtSetup({
      districts: [
        district({ id: '4', serving_branch_id: '11' }),
        district({ id: '3' }),
        district({ id: '2', serving_branch_id: '10' }),
      ],
      custody: {
        rows: [
          custodyRow({
            id: '401',
            district_id: '4',
            holder_branch_id: '11',
            branch_id: '11',
          }),
          custodyRow({ id: '402', district_id: '4' }),
          custodyRow({
            id: '301',
            district_id: '3',
            holder_type: 'COURIER',
            holder_branch_id: '11',
            courier_id: '45',
            branch_id: '11',
          }),
          // 2: o'zgarmaydi (allaqachon 10) — so'ralmaydi ham.
          custodyRow({
            id: '201',
            district_id: '2',
            holder_branch_id: '11',
            branch_id: '11',
          }),
        ],
      },
    });

    const res = await ok(
      ctx.service.setDistrictServingBranch('10', ['4', '3', '2'], SA),
    );

    expect(res.data).toEqual({
      branch_id: '10',
      district_ids: ['4', '3', '2'],
      added: ['4', '3'],
      removed: [],
      moved: [{ district_id: '4', from_branch_id: '11' }],
      coverage_exemptions: { created: 0, by_branch: [] },
    });
    expect(ctx.pairs()).toEqual([]);
    expect(ctx.exemptions.manager.query).not.toHaveBeenCalled();
    // Tuman ustuni baribir yoziladi (PUT /branches/:id/districts chaqirilaveradi).
    expect(ctx.districtRepo.rows.get('4')?.serving_branch_id).toBe('10');
    expect(ctx.districtRepo.rows.get('3')?.serving_branch_id).toBe('10');
  });

  it('⭐ bo‘shatildi (10 → null), filial viloyatsiz — imtiyoz YO‘Q (viloyatsiz filial oldin ham xizmat qilmasdi)', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '1', serving_branch_id: '10' })],
      custody: {
        rows: [custodyRow({ id: '111', district_id: '1' })],
      },
      branches: { ...BRANCHES, '10': branch('10', { region_id: null }) },
    });

    const res = await ok(ctx.service.setDistrictServingBranch('10', [], SA));

    expect(res.data).toMatchObject({
      removed: ['1'],
      coverage_exemptions: { created: 0, by_branch: [] },
    });
    expect(ctx.pairs()).toEqual([]);
    expect(ctx.districtRepo.rows.get('1')?.serving_branch_id).toBeNull();
  });

  it('bo‘shatildi, filial viloyati = tuman viloyati — baribir xizmat qiladi, imtiyoz yo‘q', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '1', serving_branch_id: '10' })],
      custody: { rows: [custodyRow({ id: '111', district_id: '1' })] },
    });

    const res = await ok(ctx.service.setDistrictServingBranch('10', [], SA));

    expect(res.data.coverage_exemptions).toEqual({ created: 0, by_branch: [] });
    expect(ctx.exemptions.rows).toHaveLength(0);
  });

  it('⭐ order-service ishlamaydi — custody O‘QILMAYDI, 503 emas: tuman yoziladi (viloyat o‘zgarmaydi — imtiyoz bo‘lmaydi)', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '4', serving_branch_id: '11' })],
      custody: 'down',
    });

    const res = await ok(ctx.service.setDistrictServingBranch('10', ['4'], SA));

    expect(res.statusCode).toBe(200);
    expect(res.data.coverage_exemptions).toEqual({ created: 0, by_branch: [] });
    expect(custodyCalls(ctx.orderClient)).toHaveLength(0);
    expect(ctx.districtRepo.rows.get('4')?.serving_branch_id).toBe('10');
    expect(ctx.activityLog.logChange).toHaveBeenCalled();
  });

  it('⭐ yoziladigan imtiyoz yo‘q — INSERT chaqirilmaydi, uning xatosi ko‘chishni to‘xtatmaydi (avval rollback + 503 edi)', async () => {
    const exemptions = exemptionRepoOf();
    exemptions.failInserts();
    const ctx = districtSetup({
      districts: [district({ id: '4', serving_branch_id: '11' })],
      custody: {
        rows: [
          custodyRow({
            id: '401',
            district_id: '4',
            holder_branch_id: '11',
            branch_id: '11',
          }),
        ],
      },
      exemptions,
    });

    const res = await ok(ctx.service.setDistrictServingBranch('10', ['4'], SA));

    expect(res.statusCode).toBe(200);
    expect(ctx.exemptions.manager.query).not.toHaveBeenCalled();
    expect(ctx.districtRepo.rows.get('4')?.serving_branch_id).toBe('10');
  });

  it('⭐ COMMIT‘dan keyin qayta snapshot: oraliqda 11 custody‘siga kirgan buyurtma ham imtiyozsiz', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '4', serving_branch_id: '11' })],
      custody: {
        rows: [
          custodyRow({
            id: '401',
            district_id: '4',
            holder_branch_id: '11',
            branch_id: '11',
          }),
        ],
        afterFirstRead: (rows) => {
          rows.push(
            custodyRow({
              id: '402',
              district_id: '4',
              holder_type: 'COURIER',
              holder_branch_id: '11',
              courier_id: '45',
              branch_id: '11',
            }),
          );
        },
      },
    });

    const res = await ok(ctx.service.setDistrictServingBranch('10', ['4'], SA));

    expect(ctx.pairs()).toEqual([]);
    expect(res.data.coverage_exemptions).toEqual({ created: 0, by_branch: [] });
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '4',
        new_value: {
          serving_branch_id: '10',
          coverage_exemptions: { created: 0, by_branch: [] },
        },
      }),
    );
  });

  it('⭐ qayta snapshot YO‘Q (viloyat o‘zgarmaydi) — tumanlar ko‘chgan, custody o‘qilmagan, ERROR log yo‘q', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '4', serving_branch_id: '11' })],
      custody: {
        rows: [
          custodyRow({
            id: '401',
            district_id: '4',
            holder_branch_id: '11',
            branch_id: '11',
          }),
        ],
        failAfter: 1,
      },
    });

    const res = await ok(ctx.service.setDistrictServingBranch('10', ['4'], SA));

    expect(res.statusCode).toBe(200);
    expect(ctx.districtRepo.rows.get('4')?.serving_branch_id).toBe('10');
    expect(res.data.coverage_exemptions).toEqual({ created: 0, by_branch: [] });
    expect(custodyCalls(ctx.orderClient)).toHaveLength(0);
    expect(ctx.logger.error).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------- clearDistrictServingBranch

describe('clearDistrictServingBranch — best-effort imtiyoz', () => {
  // Viloyat qoidasi (anKpzwxk): xizmat filialini bo'shatish qamrovni
  // o'zgartirmaydi — imtiyoz yozilmaydi (avval yo'qotgan filialga yozilardi).
  // Filial viloyati o'zgargan bo'lsa, u ko'chishdan oldin ham (joriy filial
  // qatori bo'yicha) eski viloyat tumaniga xizmat qilmaydi.
  it('⭐ filial viloyati o‘zgardi (1 → 2): tumanlar bo‘shatiladi, imtiyoz YO‘Q (avval 10 ga 1 ta edi)', async () => {
    const ctx = districtSetup({
      districts: [
        district({ id: '1', serving_branch_id: '10' }),
        district({ id: '2', serving_branch_id: '10' }),
      ],
      custody: {
        rows: [
          custodyRow({ id: '111', district_id: '1' }),
          custodyRow({
            id: '211',
            district_id: '2',
            holder_branch_id: '11',
            branch_id: '11',
          }),
        ],
      },
      branches: { ...BRANCHES, '10': branch('10', { region_id: '2' }) },
    });

    const res = await ok(ctx.service.clearDistrictServingBranch('10'));

    expect(res.data).toEqual({
      branch_id: '10',
      cleared: 2,
      coverage_exemptions: { created: 0, by_branch: [] },
    });
    expect(ctx.pairs()).toEqual([]);
    expect(ctx.exemptions.manager.query).not.toHaveBeenCalled();
    expect(ctx.districtRepo.rows.get('1')?.serving_branch_id).toBeNull();
    expect(ctx.districtRepo.rows.get('2')?.serving_branch_id).toBeNull();
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '1',
        new_value: {
          serving_branch_id: null,
          coverage_exemptions: { created: 0, by_branch: [] },
        },
      }),
    );
  });

  it('⭐ order-service ishlamaydi — custody O‘QILMAYDI (viloyat o‘zgarmaydi), tumanlar bo‘shatiladi, xato yo‘q', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '1', serving_branch_id: '10' })],
      custody: 'down',
    });

    const res = await ok(ctx.service.clearDistrictServingBranch('10'));

    expect(res.data).toEqual({
      branch_id: '10',
      cleared: 1,
      coverage_exemptions: { created: 0, by_branch: [] },
    });
    expect(custodyCalls(ctx.orderClient)).toHaveLength(0);
    expect(ctx.districtRepo.rows.get('1')?.serving_branch_id).toBeNull();
    expect(ctx.logger.error).not.toHaveBeenCalled();
    expect(ctx.activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '1',
        new_value: {
          serving_branch_id: null,
          coverage_exemptions: { created: 0, by_branch: [] },
        },
      }),
    );
  });

  it('⭐ bo‘shatishda custody umuman o‘qilmaydi — oraliqda kirgan buyurtma ham imtiyozsiz; filial xizmati ham chaqirilmaydi', async () => {
    const ctx = districtSetup({
      districts: [district({ id: '1', serving_branch_id: '10' })],
      custody: {
        rows: [custodyRow({ id: '111', district_id: '1' })],
        afterFirstRead: (rows) => {
          rows.push(custodyRow({ id: '112', district_id: '1' }));
        },
      },
      branches: { ...BRANCHES, '10': branch('10', { region_id: '2' }) },
    });

    const res = await ok(ctx.service.clearDistrictServingBranch('10'));

    expect(ctx.pairs()).toEqual([]);
    expect(custodyCalls(ctx.orderClient)).toHaveLength(0);
    expect(res.data).toEqual({
      branch_id: '10',
      cleared: 1,
      coverage_exemptions: { created: 0, by_branch: [] },
    });

    // Oldingi snapshot yiqildi (filial xizmati), keyingisi muvaffaqiyatli.
    let branchCalls = 0;
    const flaky = districtSetup({
      districts: [district({ id: '1', serving_branch_id: '10' })],
      custody: { rows: [custodyRow({ id: '111', district_id: '1' })] },
      branches: { ...BRANCHES, '10': branch('10', { region_id: '2' }) },
    });
    const send = flaky.branchClient.send.getMockImplementation()!;
    flaky.branchClient.send.mockImplementation((pattern, payload) => {
      if (pattern.cmd === 'branch.find_by_id' && (branchCalls += 1) === 1) {
        return throwError(() => new Error('branch-service down'));
      }
      return send(pattern, payload);
    });

    const recovered = await ok(flaky.service.clearDistrictServingBranch('10'));

    expect(flaky.pairs()).toEqual([]);
    expect(recovered.data).toEqual({
      branch_id: '10',
      cleared: 1,
      coverage_exemptions: { created: 0, by_branch: [] },
    });
  });
});

// --------------------------------------------------------------- mergeDistricts

describe('mergeDistricts — A → B ko‘chishida imtiyoz (birinchi ko‘chirishdan OLDIN)', () => {
  // Viloyat qoidasi (anKpzwxk): imtiyoz faqat xizmat viloyati o'zgarganda —
  // A (5) viloyat 1 da (filiallar 10, 11), B (6) viloyat 2 da (filial 20).
  // serving_branch_id endi ahamiyatsiz (avval A — 10 niki, B — 11 niki edi).
  const districts = [
    district({ id: '5', serving_branch_id: '10' }),
    district({ id: '6', region_id: '2', serving_branch_id: '20' }),
  ];

  it('A ga xizmat qilib B ga xizmat qilmaydigan filial (10) qo‘lidagilar imtiyozli; B viloyati filiali (20) — yo‘q', async () => {
    const ctx = districtSetup({
      districts,
      custody: {
        rows: [
          custodyRow({ id: '501', district_id: '5' }),
          custodyRow({
            id: '502',
            district_id: '5',
            holder_branch_id: '20',
            branch_id: '20',
          }),
        ],
      },
    });

    const res = await ok(ctx.service.mergeDistricts('5', '6'));

    expect(res.data.coverage_exemptions).toEqual({
      created: 1,
      by_branch: [{ branch_id: '10', count: 1 }],
    });
    expect(ctx.pairs()).toEqual(['501@10']);
    // Imtiyozda B (buyurtmaning ko'chishdan keyingi tumani).
    expect(ctx.exemptions.rows[0]).toMatchObject({
      district_id: '6',
      source: 'district_merge',
    });
    const cmds = ctx.orderClient.send.mock.calls.map(
      ([pattern]) => pattern.cmd,
    );
    expect(cmds.indexOf('order.open_custody_by_district')).toBeLessThan(
      cmds.indexOf('order.geo.reassign_district'),
    );
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'district.merge',
        new_value: {
          merged_into: '6',
          coverage_exemptions: {
            created: 1,
            by_branch: [{ branch_id: '10', count: 1 }],
          },
        },
      }),
    );
  });

  it('⭐ fail closed: custody o‘qilmadi — 503, hech narsa ko‘chmaydi, A o‘chmaydi', async () => {
    const ctx = districtSetup({ districts, custody: 'down' });

    const error = await rpcError(ctx.service.mergeDistricts('5', '6'));

    expect(error.statusCode).toBe(503);
    expect(error.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);
    const cmds = [
      ...ctx.orderClient.send.mock.calls,
      ...ctx.branchClient.send.mock.calls,
    ].map(([pattern]) => pattern.cmd);
    expect(cmds).not.toContain('order.geo.reassign_district');
    expect(cmds).not.toContain('branch.reassign_district');
    expect(ctx.districtRepo.manager.transaction).not.toHaveBeenCalled();
    expect(ctx.districtRepo.rows.has('5')).toBe(true);
  });

  it('⭐ fail closed: imtiyoz yozish (INSERT) yiqildi — 503, hech narsa ko‘chmaydi, A o‘chmaydi', async () => {
    const exemptions = exemptionRepoOf();
    exemptions.failInserts();
    const ctx = districtSetup({
      districts,
      custody: { rows: [custodyRow({ id: '501', district_id: '5' })] },
      exemptions,
    });

    const error = await rpcError(ctx.service.mergeDistricts('5', '6'));

    expect(error.statusCode).toBe(503);
    expect(error.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);
    expect(ctx.exemptions.manager.query).toHaveBeenCalledTimes(1);
    expect(ctx.exemptions.rows).toHaveLength(0);
    const cmds = [
      ...ctx.orderClient.send.mock.calls,
      ...ctx.branchClient.send.mock.calls,
    ].map(([pattern]) => pattern.cmd);
    expect(cmds).not.toContain('order.geo.reassign_district');
    expect(cmds).not.toContain('branch.reassign_district');
    expect(ctx.districtRepo.manager.transaction).not.toHaveBeenCalled();
    expect(ctx.districtRepo.rows.has('5')).toBe(true);
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('⭐ birlashtirilgach qayta snapshot: oraliqda 10 ga kirgan A buyurtmasi imtiyozli (tuman B), B ning o‘z buyurtmasi — yo‘q', async () => {
    const ctx = districtSetup({
      districts,
      custody: {
        rows: [
          custodyRow({ id: '501', district_id: '5' }),
          // B ning o'z buyurtmasi filial 10 qo'lida — A qamroviga tegishli emas.
          custodyRow({ id: '601', district_id: '6' }),
        ],
        // Snapshot va ko'chirish orasida 502 filial 10 ga qabul qilindi.
        afterFirstRead: (rows) => {
          rows.push(custodyRow({ id: '502', district_id: '5' }));
        },
      },
    });

    const res = await ok(ctx.service.mergeDistricts('5', '6'));

    expect(ctx.pairs()).toEqual(['501@10', '502@10']);
    expect(ctx.exemptions.rows.map((row) => row.district_id)).toEqual([
      '6',
      '6',
    ]);
    expect(res.data.coverage_exemptions).toEqual({
      created: 2,
      by_branch: [{ branch_id: '10', count: 2 }],
    });
    // Qayta o'qish — B (ko'chgan buyurtmalar endi B da), ko'chirishdan keyin.
    const calls = custodyCalls(ctx.orderClient).map(([, payload]) => payload);
    expect(calls.map((payload) => payload.district_ids)).toEqual([
      ['5'],
      ['6'],
    ]);
    // …va A o'chirilib, tranzaksiya COMMIT bo'lgandan keyin.
    expect(ctx.orderClient.custodyReads).toEqual([
      { commits: 0, districts: ['5', '6'] },
      { commits: 1, districts: ['6'] },
    ]);
  });

  it('⭐ qayta snapshot yiqildi — birlashtirish muvaffaqiyatli, ERROR log (tumanlar bilan)', async () => {
    const ctx = districtSetup({
      districts,
      custody: {
        rows: [custodyRow({ id: '501', district_id: '5' })],
        failAfter: 1,
      },
    });

    const res = await ok(ctx.service.mergeDistricts('5', '6'));

    expect(res.statusCode).toBe(200);
    expect(ctx.districtRepo.rows.has('5')).toBe(false);
    expect(res.data.coverage_exemptions).toEqual({
      created: 1,
      by_branch: [{ branch_id: '10', count: 1 }],
    });
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('mergeDistricts #5 → #6: tuman(lar) #6'),
    );
  });

  it('⭐ qayta snapshot faqat ko‘chgan buyurtmalar filialini so‘raydi: B ning o‘z buyurtmasi filiali (30) xatosi yiqitmaydi', async () => {
    const ctx = districtSetup({
      districts,
      branches: { ...BRANCHES, '30': 'down' },
      custody: {
        rows: [
          custodyRow({ id: '501', district_id: '5' }),
          // B ning o'z buyurtmasi — filial 30 qo'lida (filial xizmati xato).
          custodyRow({
            id: '601',
            district_id: '6',
            holder_branch_id: '30',
            branch_id: '30',
          }),
        ],
        afterFirstRead: (rows) => {
          rows.push(custodyRow({ id: '502', district_id: '5' }));
        },
      },
    });

    const res = await ok(ctx.service.mergeDistricts('5', '6'));

    expect(ctx.pairs()).toEqual(['501@10', '502@10']);
    expect(res.data.coverage_exemptions).toEqual({
      created: 2,
      by_branch: [{ branch_id: '10', count: 2 }],
    });
    expect(ctx.logger.error).not.toHaveBeenCalled();
    const lookedUp = ctx.branchClient.send.mock.calls
      .filter(([pattern]) => pattern.cmd === 'branch.find_by_id')
      .map(([, payload]) => String(payload.id));
    expect(lookedUp).not.toContain('30');
  });

  /**
   * A (5) va B (6) ikkalasi viloyat 2 da (filial 20): 10 ning imtiyozlari
   * oldingi (viloyat 1 → 2) ko'chishdan; birlashtirish yangi imtiyoz bermaydi.
   */
  const servedBy20 = [
    district({ id: '5', assigned_region: '2' }),
    district({ id: '6', region_id: '2' }),
  ];

  it('⭐ oldingi ko‘chish imtiyozi (tuman A) ko‘chgan buyurtma bilan B ga o‘tadi; birlashtirishdan oldin B ga tahrirlangani — o‘tmaydi', async () => {
    const ctx = districtSetup({
      districts: servedBy20,
      exemptions: exemptionRepoOf([
        { order_id: '501', branch_id: '10', district_id: '5' },
        // 502 birlashtirishdan OLDIN 5 → 6 tahrirlangan (ko'chmaydi).
        { order_id: '502', branch_id: '10', district_id: '5' },
        // Boshqa tumanniki — tegilmaydi.
        { order_id: '701', branch_id: '10', district_id: '7' },
      ]),
      custody: {
        rows: [
          custodyRow({ id: '501', district_id: '5' }),
          custodyRow({ id: '502', district_id: '6' }),
        ],
      },
    });

    const res = await ok(ctx.service.mergeDistricts('5', '6'));

    expect(
      ctx.exemptions.rows.map(
        (row) => `${row.order_id}@${row.branch_id}#${row.district_id}`,
      ),
    ).toEqual(['501@10#6', '502@10#5', '701@10#7']);
    // Qayta yo'naltirish yangi imtiyoz emas — sonlarga kirmaydi.
    expect(res.data.coverage_exemptions).toEqual({
      created: 0,
      by_branch: [],
    });
  });

  it('⭐ qayta yo‘naltirish yiqildi — birlashtirish muvaffaqiyatli, ERROR log (tumanlar bilan)', async () => {
    const exemptions = exemptionRepoOf([
      { order_id: '501', branch_id: '10', district_id: '5' },
    ]);
    exemptions.failQueries('UPDATE');
    const ctx = districtSetup({
      districts: servedBy20,
      exemptions,
      custody: { rows: [custodyRow({ id: '501', district_id: '5' })] },
    });

    const res = await ok(ctx.service.mergeDistricts('5', '6'));

    expect(res.statusCode).toBe(200);
    expect(ctx.districtRepo.rows.has('5')).toBe(false);
    expect(ctx.exemptions.rows[0].district_id).toBe('5');
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "mergeDistricts #5 → #6: ko'chgan buyurtmalarning tuman #5 imtiyozlarini #6 ga o'tkazib bo'lmadi",
      ),
    );
  });

  /** Foydalanuvchilarni ko'chirish rad etiladi (409) — birlashtirish bekor. */
  const refuseUsers = (ctx: ReturnType<typeof districtSetup>) => {
    const send = ctx.identityClient.send.getMockImplementation()!;
    ctx.identityClient.send.mockImplementation(
      (pattern: { cmd: string }): Observable<unknown> =>
        pattern.cmd === 'identity.user.reassign_district'
          ? throwError(() => ({ statusCode: 400, message: 'rad etildi' }))
          : send(pattern),
    );
  };

  it('⭐ birlashtirish bekor bo‘ldi — shu birlashtirish yozgan B tumanli imtiyozlar o‘chadi (buyurtmalar A da), boshqalari qoladi', async () => {
    const ctx = districtSetup({
      districts,
      exemptions: exemptionRepoOf([
        // Boshqa amal yozgan B tumanli qator — tegilmaydi.
        {
          order_id: '601',
          branch_id: '10',
          district_id: '6',
          source: 'set_serving_branch',
        },
      ]),
      custody: { rows: [custodyRow({ id: '501', district_id: '5' })] },
    });
    refuseUsers(ctx);

    const error = await rpcError(ctx.service.mergeDistricts('5', '6'));

    expect(error.statusCode).toBe(409);
    expect(ctx.districtRepo.rows.has('5')).toBe(true);
    expect(ctx.pairs()).toEqual(['601@10']);
  });

  it('bekor: B da qolgan buyurtma imtiyozi qoladi; qolganlar ID‘lari noma‘lum — hech biri o‘chmaydi (WARN)', async () => {
    // Kompensatsiya 502 ni qaytara olmadi (B da qoldi).
    const partly = districtSetup({
      districts,
      custody: {
        rows: [
          custodyRow({ id: '501', district_id: '5' }),
          custodyRow({ id: '502', district_id: '5' }),
        ],
      },
    });
    refuseUsers(partly);
    const send = partly.orderClient.send.getMockImplementation()!;
    partly.orderClient.send.mockImplementation((pattern, payload) =>
      pattern.cmd === 'order.geo.reassign_district' && payload.ids
        ? send(pattern, {
            ...payload,
            ids: (payload.ids as string[]).filter((id) => id !== '502'),
          })
        : send(pattern, payload),
    );

    expect(
      (await rpcError(partly.service.mergeDistricts('5', '6'))).statusCode,
    ).toBe(409);
    expect(partly.pairs()).toEqual(['502@10']);
    expect(partly.exemptions.rows[0].district_id).toBe('6');

    // Buyurtmalar qadami javob bermadi, lekin A dagi son kamaydi — qaysi
    // buyurtma qayerda ekani noma'lum.
    const unknown = districtSetup({
      districts,
      custody: { rows: [custodyRow({ id: '501', district_id: '5' })] },
    });
    const warn = jest
      .spyOn(
        (unknown.service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    const orderSend = unknown.orderClient.send.getMockImplementation()!;
    unknown.orderClient.send.mockImplementation((pattern, payload) => {
      if (pattern.cmd === 'order.geo.reassign_district') {
        orderSend(pattern, payload);
        return throwError(() => new Error('ulanish uzildi'));
      }
      return orderSend(pattern, payload);
    });

    expect(
      (await rpcError(unknown.service.mergeDistricts('5', '6'))).statusCode,
    ).toBe(503);
    expect(unknown.pairs()).toEqual(['501@10']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("tuman #6 imtiyozlari o'chirilmadi"),
    );
  });

  it('bekor: imtiyozlarni o‘chirish yiqildi — baribir 409 (asl sabab), ERROR log', async () => {
    const exemptions = exemptionRepoOf();
    exemptions.failQueries('DELETE');
    const ctx = districtSetup({
      districts,
      exemptions,
      custody: { rows: [custodyRow({ id: '501', district_id: '5' })] },
    });
    refuseUsers(ctx);

    const error = await rpcError(ctx.service.mergeDistricts('5', '6'));

    expect(error.statusCode).toBe(409);
    expect(ctx.pairs()).toEqual(['501@10']);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "mergeDistricts #5 → #6 bekor qilindi: tuman #6 imtiyozlarini (1 ta) o'chirib bo'lmadi",
      ),
    );
  });
});

// ------------------------------------------------------------ qamrov to'sig'i

describe('assertOrdersServedByBranch — imtiyozli buyurtma eski filial kuryeriga beriladi', () => {
  // Viloyat qoidasi (anKpzwxk): tuman 5 viloyat 1 dan (filiallar 10, 11)
  // viloyat 2 ga (filial 20) ko'chgan (assigned_region = 2); tuman 7 ham
  // viloyat 2 da (buyurtma tumani ko'chishdan keyin 7 ga tahrirlanadi).
  // Avval (#617) bu serving_branch_id 10 → 11 ko'chishi edi.
  const districts = [
    district({ id: '5', assigned_region: '2' }),
    district({ id: '7', region_id: '2' }),
  ];
  const order = (overrides: Row): Row => ({
    branch_id: '10',
    status: Order_status.RECEIVED,
    courier_id: null,
    post_id: null,
    total_price: 100_000,
    region_id: '1',
    district_id: '5',
    ...overrides,
  });

  function assignSetup(options: {
    orders: Row[];
    exemptions?: ExemptionRepo;
    managerBranchId?: string;
  }) {
    const managerBranchId = options.managerBranchId ?? '10';
    const ordersMap = new Map(
      options.orders.map((o) => [String(o.id), { ...o }]),
    );
    const exemptions = options.exemptions ?? exemptionRepoOf();
    const orderClient = orderClientOf({ rows: [] }, ordersMap);
    const branchClient = branchClientOf(BRANCHES, {
      '77': {
        branch_id: managerBranchId,
        role: 'MANAGER',
        branch: BRANCHES[managerBranchId],
      },
    });
    const identityClient = {
      send: jest.fn(() => of({ data: [{ id: '44', status: 'active' }] })),
    };
    const districtRepo = districtRepoOf(districts, exemptions);
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
      undefined,
      exemptions as any,
    );
    jest
      .spyOn(
        (service as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    const updates = () =>
      orderClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'order.update',
      );
    return { service, ordersMap, exemptions, updates };
  }

  const assign = (service: LogisticsServiceService, orderIds: string[]) =>
    service.assignOrdersToCourier(
      { id: '77', roles: ['manager'] },
      { order_ids: orderIds, courier_id: '44' },
    );

  it('⭐ imtiyozli buyurtma — eski filial (10) kuryeriga beriladi', async () => {
    const ctx = assignSetup({
      orders: [order({ id: '101' })],
      exemptions: exemptionRepoOf([{ order_id: '101', branch_id: '10' }]),
    });

    const res = await ok<Row>(assign(ctx.service, ['101']));

    expect(res.data.assigned_count).toBe(1);
    // Bitta lokal so'rov: shu buyurtmalar, shu filial, amaldagi.
    expect(ctx.exemptions.find).toHaveBeenCalledTimes(1);
    const where = ctx.exemptions.find.mock.calls[0][0].where;
    expect(where.branch_id).toBe('10');
    expect((where.order_id as FindOperator<unknown>).value).toEqual(['101']);
    expect((where.revoked_at as FindOperator<unknown>).type).toBe('isNull');
  });

  it('⭐ imtiyozsiz buyurtma — avvalgidek 403; aralashda faqat imtiyozsizlari sanaladi', async () => {
    const ctx = assignSetup({
      orders: [order({ id: '101' }), order({ id: '102' })],
      exemptions: exemptionRepoOf([{ order_id: '101', branch_id: '10' }]),
    });

    const error = await rpcError(assign(ctx.service, ['101', '102']));

    expect(error.statusCode).toBe(403);
    // Gateway faqat reason/usage/details ni o'tkazadi — id'lar `details` da ham.
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['102'],
      details: { order_ids: ['102'] },
    });
    expect(ctx.updates()).toHaveLength(0);
  });

  it('⭐ boshqa filial imtiyozi yordam bermaydi; bekor qilingan imtiyoz ham', async () => {
    const other = assignSetup({
      orders: [order({ id: '101' })],
      exemptions: exemptionRepoOf([{ order_id: '101', branch_id: '12' }]),
    });
    expect((await rpcError(assign(other.service, ['101']))).statusCode).toBe(
      403,
    );

    const revoked = assignSetup({
      orders: [order({ id: '101' })],
      exemptions: exemptionRepoOf([
        { order_id: '101', branch_id: '10', revoked_at: new Date() },
      ]),
    });
    expect((await rpcError(assign(revoked.service, ['101']))).statusCode).toBe(
      403,
    );
  });

  it('⭐ yangi viloyat filiali (20) — avvalgidek ruxsat, imtiyoz so‘ralmaydi', async () => {
    const ctx = assignSetup({
      orders: [order({ id: '101', branch_id: '20' })],
      managerBranchId: '20',
    });

    const res = await ok<Row>(assign(ctx.service, ['101']));

    expect(res.data.assigned_count).toBe(1);
    expect(ctx.exemptions.find).not.toHaveBeenCalled();
  });

  it('⭐ kuryer qaytarib bergach (WAITING, filialda) — qayta beriladi; imtiyoz o‘chmaydi', async () => {
    const ctx = assignSetup({
      orders: [order({ id: '101' })],
      exemptions: exemptionRepoOf([{ order_id: '101', branch_id: '10' }]),
    });

    expect(
      (await ok<Row>(assign(ctx.service, ['101']))).data.assigned_count,
    ).toBe(1);
    // Qaytarish tasdiqlandi: WAITING, filial qo'lida, kuryersiz.
    ctx.ordersMap.set('101', {
      ...order({ id: '101' }),
      status: Order_status.WAITING,
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      courier_id: null,
    });

    const again = await ok<Row>(assign(ctx.service, ['101']));

    expect(again.data.assigned_count).toBe(1);
    expect(ctx.exemptions.rows).toHaveLength(1);
    expect(ctx.exemptions.rows[0].revoked_at).toBeNull();
  });

  it('imtiyoz jadvalini o‘qib bo‘lmadi — 503 (fail closed), hech narsa yozilmaydi', async () => {
    const exemptions = exemptionRepoOf();
    exemptions.find.mockRejectedValueOnce(new Error('DB yiqildi'));
    const ctx = assignSetup({ orders: [order({ id: '101' })], exemptions });

    const error = await rpcError(assign(ctx.service, ['101']));

    expect(error.statusCode).toBe(503);
    expect(ctx.updates()).toHaveLength(0);
  });

  it('scanAssignOrder: eski filial kuryeri imtiyozli buyurtmani skan qilib oladi', async () => {
    const exemptions = exemptionRepoOf([{ order_id: '101', branch_id: '10' }]);
    const scanned = order({ id: '101', status: Order_status.RECEIVED });
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'order.find_by_qr'
          ? of({ data: scanned })
          : of({ ok: true }),
      ),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.find_hq'
          ? of({ data: { id: '1' } })
          : of({ data: { branch_id: '10', branch: BRANCHES['10'] } }),
      ),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((entity: Row) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
      ),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      districtRepoOf(districts, exemptions) as any,
      orderClient as any,
      branchClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      undefined,
      exemptions as any,
    );

    const res = await ok<Row>(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc' },
      ),
    );
    expect(res.data.order_id).toBe('101');

    // Imtiyozsiz — 403.
    const blocked = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      districtRepoOf(districts, exemptionRepoOf()) as any,
      orderClient as any,
      branchClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      undefined,
      exemptionRepoOf() as any,
    );
    const error = await rpcError(
      blocked.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc' },
      ),
    );
    expect(error.statusCode).toBe(403);
  });

  it('⭐ imtiyoz faqat buyurtmaning HOZIRGI tumanida: mos — ruxsat, boshqa tuman — 403, tumansiz (eski qator) — ruxsat', async () => {
    const matching = assignSetup({
      orders: [order({ id: '101' })],
      exemptions: exemptionRepoOf([
        { order_id: '101', branch_id: '10', district_id: '5' },
      ]),
    });
    expect(
      (await ok<Row>(assign(matching.service, ['101']))).data.assigned_count,
    ).toBe(1);

    const otherDistrict = assignSetup({
      orders: [order({ id: '101' })],
      exemptions: exemptionRepoOf([
        { order_id: '101', branch_id: '10', district_id: '6' },
      ]),
    });
    const error = await rpcError(assign(otherDistrict.service, ['101']));
    expect(error.statusCode).toBe(403);
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['101'],
      details: { order_ids: ['101'] },
    });

    const legacy = assignSetup({
      orders: [order({ id: '101' })],
      exemptions: exemptionRepoOf([
        { order_id: '101', branch_id: '10', district_id: null },
      ]),
    });
    expect(
      (await ok<Row>(assign(legacy.service, ['101']))).data.assigned_count,
    ).toBe(1);
  });

  /**
   * Tuman 5 ni viloyat 1 dan viloyat 2 ga ko'chirish (`updateDistrict`,
   * imtiyozlar `exemptions` ga). Avval bu serving_branch_id 10 → 11 edi —
   * viloyat qoidasida u imtiyoz bermaydi.
   */
  async function moveDistrict5ToRegion2(
    rows: OpenCustodyRow[],
    exemptions: ExemptionRepo,
  ) {
    const move = districtSetup({
      districts: [district({ id: '5', serving_branch_id: '10' })],
      custody: { rows },
      exemptions,
    });
    await ok(move.service.updateDistrict('5', { assigned_region: '2' }, SA));
  }

  it('⭐ ko‘chishda 10 qo‘lidagi BEKOR buyurtma: imtiyozli, WAITING ga qaytarilgach 10 kuryeriga beriladi', async () => {
    const exemptions = exemptionRepoOf();
    await moveDistrict5ToRegion2(
      [
        custodyRow({ id: '101', status: Order_status.CANCELLED }),
        custodyRow({
          id: '102',
          status: Order_status.SOLD,
          holder_type: 'COURIER',
          holder_branch_id: '10',
          holder_courier_id: '44',
          courier_id: '44',
        }),
      ],
      exemptions,
    );
    expect(
      exemptions.rows.map(
        (row) => `${row.order_id}@${row.branch_id}#${row.district_id}`,
      ),
    ).toEqual(['101@10#5', '102@10#5']);

    // rollbackOrderToWaiting: 10 menejeri bekorni WAITING ga qaytardi.
    const ctx = assignSetup({
      orders: [
        order({
          id: '101',
          status: Order_status.WAITING,
          holder_type: 'BRANCH',
          holder_branch_id: '10',
        }),
        // Ko'chishda 10 da bo'lmagan — imtiyozsiz.
        order({ id: '103' }),
      ],
      exemptions,
    });

    expect(
      (await ok<Row>(assign(ctx.service, ['101']))).data.assigned_count,
    ).toBe(1);
    const error = await rpcError(assign(ctx.service, ['103']));
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['103'],
      details: { order_ids: ['103'] },
    });
  });

  it('⭐ ko‘chishdan keyin buyurtma tumani tahrirlandi (5 → 7) — imtiyoz endi yordam bermaydi: 403', async () => {
    const exemptions = exemptionRepoOf();
    await moveDistrict5ToRegion2([custodyRow({ id: '101' })], exemptions);
    expect(exemptions.rows).toHaveLength(1);

    const ctx = assignSetup({
      orders: [order({ id: '101', district_id: '7' })],
      exemptions,
    });

    const error = await rpcError(assign(ctx.service, ['101']));

    expect(error.statusCode).toBe(403);
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['101'],
      details: { order_ids: ['101'] },
    });
    expect(ctx.updates()).toHaveLength(0);
  });

  it('⭐ ko‘chish (5: viloyat 1 → 2), so‘ng birlashtirish (5 → 7): 10 imtiyozi buyurtma bilan o‘tadi — beriladi; oldin 7 ga tahrirlangani — 403', async () => {
    const exemptions = exemptionRepoOf();
    await moveDistrict5ToRegion2(
      [custodyRow({ id: '101' }), custodyRow({ id: '102' })],
      exemptions,
    );
    // 102 birlashtirishdan OLDIN 5 → 7 tahrirlandi; 101 birlashtirishda ko'chadi.
    const merge = districtSetup({
      districts,
      custody: {
        rows: [
          custodyRow({ id: '101' }),
          custodyRow({ id: '102', district_id: '7' }),
        ],
      },
      exemptions,
    });
    await ok(merge.service.mergeDistricts('5', '7'));

    const ctx = assignSetup({
      orders: [
        order({ id: '101', district_id: '7' }),
        order({ id: '102', district_id: '7' }),
      ],
      exemptions,
    });

    expect(
      (await ok<Row>(assign(ctx.service, ['101']))).data.assigned_count,
    ).toBe(1);
    const error = await rpcError(assign(ctx.service, ['102']));
    expect(error.statusCode).toBe(403);
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['102'],
      details: { order_ids: ['102'] },
    });
  });

  it('⭐ bekor bo‘lgan birlashtirish (5 → 7): uning imtiyozi qolmaydi — buyurtma keyin 7 ga tahrirlansa 403', async () => {
    const exemptions = exemptionRepoOf();
    const merge = districtSetup({
      districts: [district({ id: '5' }), district({ id: '7', region_id: '2' })],
      custody: { rows: [custodyRow({ id: '101' })] },
      exemptions,
    });
    const send = merge.identityClient.send.getMockImplementation()!;
    merge.identityClient.send.mockImplementation(
      (pattern: { cmd: string }): Observable<unknown> =>
        pattern.cmd === 'identity.user.reassign_district'
          ? throwError(() => ({ statusCode: 400, message: 'rad etildi' }))
          : send(pattern),
    );
    expect(
      (await rpcError(merge.service.mergeDistricts('5', '7'))).statusCode,
    ).toBe(409);

    const ctx = assignSetup({
      orders: [order({ id: '101', district_id: '7' })],
      exemptions,
    });

    const error = await rpcError(assign(ctx.service, ['101']));
    expect(error.statusCode).toBe(403);
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['101'],
      details: { order_ids: ['101'] },
    });
  });
});
