/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { of } from 'rxjs';
import { FindOperator } from 'typeorm';
import { BranchServiceService } from '../src/branch-service.service';

/**
 * TEST UCHUN (8jtzNlFt, cI5gqN90): branch-service'ning HAQIQIY
 * `BranchServiceService` i xotiradagi `branches` / `branch_users` jadvallari
 * ustida. Specs'lar (branch-service, gateway e2e, order-service) shu orqali
 * "real ma'lumot" — createBranch yozgan qator — bilan ishlaydi: mock javob
 * emas, servisning o'zi qaytargan payload. Build'ga kirmaydi
 * (tsconfig.app.json `test` ni chiqarib tashlaydi).
 */
type Row = Record<string, any>;

function operatorOf(value: unknown): { type: string; value: unknown } | null {
  if (!(value instanceof FindOperator)) return null;
  const op = value as any;
  return { type: String(op.type ?? op._type), value: op.value ?? op._value };
}

export function matchesWhere(row: Row, where?: Row | Row[]): boolean {
  if (!where) return true;
  if (Array.isArray(where)) return where.some((w) => matchesWhere(row, w));
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    const op = operatorOf(expected);
    if (op) {
      if (op.type === 'in') {
        return (op.value as unknown[]).map(String).includes(String(actual));
      }
      if (op.type === 'not') return String(actual) !== String(op.value);
      throw new Error('memory repo: operator ' + op.type + ' qo`llanmaydi');
    }
    if (expected === null) return actual === null || actual === undefined;
    return String(actual) === String(expected);
  });
}

export interface MemoryRepo {
  rows: Row[];
  [key: string]: any;
}

export function createMemoryRepo(
  defaults: () => Row,
  tablePath: string,
): MemoryRepo {
  const rows: Row[] = [];
  let seq = 0;
  const clone = (row: Row) => ({ ...row });

  const save = (input: Row) => {
    if (input.id && rows.some((r) => String(r.id) === String(input.id))) {
      const target = rows.find((r) => String(r.id) === String(input.id))!;
      Object.assign(target, input, { updatedAt: new Date() });
      return Promise.resolve(clone(target));
    }
    seq += 1;
    const now = new Date(Date.UTC(2026, 5, 1, 7, 0, seq));
    const row: Row = {
      ...defaults(),
      ...input,
      id: input.id ? String(input.id) : String(seq),
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      isDeleted: input.isDeleted ?? false,
    };
    rows.push(row);
    return Promise.resolve(clone(row));
  };

  const queryBuilder = () => {
    const params: Row = {};
    let skip = 0;
    let take = Number.POSITIVE_INFINITY;
    const qb: Row = {};
    const collect = (_sql: unknown, p?: Row) => {
      Object.assign(params, p ?? {});
      return qb;
    };
    Object.assign(qb, {
      where: collect,
      andWhere: collect,
      orderBy: () => qb,
      skip: (n: number) => {
        skip = n;
        return qb;
      },
      take: (n: number) => {
        take = n;
        return qb;
      },
      // ensureBranchNameUnique: nom bo'yicha (katta-kichik harfsiz).
      getOne: () =>
        Promise.resolve(
          rows.find(
            (r) =>
              !r.isDeleted &&
              String(r.name ?? '')
                .trim()
                .toLowerCase() ===
                String(params.name ?? '')
                  .trim()
                  .toLowerCase(),
          ) ?? null,
        ),
      // findAllBranches: o'chirilmagan, ixtiyoriy status/ruxsat, createdAt DESC.
      getManyAndCount: () => {
        const filtered = rows
          .filter((r) => !r.isDeleted)
          .filter((r) => !params.status || r.status === params.status)
          .filter(
            (r) =>
              !params.allowedBranchIds ||
              (params.allowedBranchIds as string[])
                .map(String)
                .includes(String(r.id)),
          )
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );
        return Promise.resolve([
          filtered.slice(skip, skip + take).map(clone),
          filtered.length,
        ]);
      },
    });
    return qb;
  };

  return {
    rows,
    create: (input: Row) => ({ ...input }),
    save: (input: Row) => save(input),
    findOne: ({ where }: { where?: Row }) =>
      Promise.resolve(
        (() => {
          const found = rows.find((r) => matchesWhere(r, where));
          return found ? clone(found) : null;
        })(),
      ),
    find: (options?: { where?: Row | Row[] }) =>
      Promise.resolve(
        rows.filter((r) => matchesWhere(r, options?.where)).map(clone),
      ),
    count: (options?: { where?: Row }) =>
      Promise.resolve(
        rows.filter((r) => matchesWhere(r, options?.where)).length,
      ),
    createQueryBuilder: queryBuilder,
    manager: { query: () => Promise.resolve([]) },
    metadata: { tablePath },
  };
}

/** Haqiqiy BranchServiceService — xotiradagi jadvallar ustida. */
export function createMemoryBranchService() {
  const branchRepo = createMemoryRepo(
    () => ({
      address: null,
      phone_number: null,
      region_id: null,
      district_id: null,
      parent_id: null,
      level: 0,
      code: null,
      status: 'active',
      manager_id: null,
      // Entity sukutlari (branch.entity.ts).
      ownership: 'owned',
      per_order_share: 0,
    }),
    'branch_schema.branches',
  );
  const branchUserRepo = createMemoryRepo(
    () => ({ role: 'REGISTRATOR' }),
    'branch_schema.branch_users',
  );
  const client = () => ({
    send: jest.fn(() => of({ data: [] })),
  });
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new BranchServiceService(
    branchRepo as never,
    branchUserRepo as never,
    { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) } as never,
    client() as never, // identity
    client() as never, // logistics
    client() as never, // order
    client() as never, // file
    client() as never, // finance
    { get: (_key: string, fallback?: string) => fallback } as never,
    activityLog as never,
  );
  return { service, branchRepo, branchUserRepo, activityLog };
}
