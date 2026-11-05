/**
 * (hwTkXsGi) Qo'shimcha xarajat so'rovlari jadvali — spec'lar uchun xotiradagi
 * soxta repozitoriya (build'ga kirmaydi: `*spec.ts`, jest esa faqat
 * `.spec.ts` ni ishga tushiradi).
 *
 * Sotish / bekor qilish / qisman sotish / rollback endi tranzaksiya ichida
 * so'rovlarni yopadi (`void` / `reversed`) va tasdiqni shartli UPDATE bilan
 * yozadi. Jadval shu UPDATE'larning WHERE shartlarini haqiqatan qo'llaydi:
 * shart mos kelmasa qator o'zgarmaydi va `affected = 0` — xuddi Postgres kabi.
 * Tanimagan shart — xato (spec jimgina noto'g'ri o'tib ketmasin).
 */
import { OrderExtraCostApproval } from '../entities/order-extra-cost-approval.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { Order } from '../entities/order.entity';

export type ExtraCostApprovalRow = Record<string, unknown> & {
  id: string;
  order_id: string;
  status: string;
};

type Params = Record<string, unknown>;
type RowFilter = (row: ExtraCostApprovalRow) => boolean;

const COLUMN: Record<string, string> = { is_deleted: 'isDeleted' };
/** `a.status` / `status` / `is_deleted` / `"createdAt"` → qatordagi maydon. */
const field = (column: string) => {
  const name = column.replace(/^\w+\./, '').replace(/"/g, '');
  return COLUMN[name] ?? name;
};
const clone = <T>(value: T): T => structuredClone(value);
const comparable = (value: unknown) =>
  value instanceof Date ? value.getTime() : Number(value);

const TERMS: Array<
  [RegExp, (m: RegExpExecArray, params: Params) => RowFilter]
> = [
  [
    /^([\w."]+) = :(\w+)$/,
    ([, c, p], params) =>
      (row) =>
        String(row[field(c)]) === String(params[p]),
  ],
  [
    /^([\w."]+) = (true|false)$/,
    ([, c, v]) =>
      (row) =>
        Boolean(row[field(c)]) === (v === 'true'),
  ],
  [
    /^([\w."]+) <> :(\w+)$/,
    ([, c, p], params) =>
      (row) =>
        String(row[field(c)]) !== String(params[p]),
  ],
  [
    /^([\w."]+) IN \(:\.\.\.(\w+)\)$/,
    ([, c, p], params) => {
      const values = (params[p] as unknown[]).map(String);
      return (row) => values.includes(String(row[field(c)]));
    },
  ],
  [
    /^([\w."]+) IS NULL$/,
    ([, c]) =>
      (row) =>
        row[field(c)] == null,
  ],
  [
    /^([\w."]+) IS NOT NULL$/,
    ([, c]) =>
      (row) =>
        row[field(c)] != null,
  ],
  [
    /^([\w."]+) (<=|<|>=|>) :(\w+)$/,
    ([, c, op, p], params) =>
      (row) => {
        // SQL kabi: NULL bilan solishtirish — rost emas.
        if (row[field(c)] == null || params[p] == null) return false;
        const a = comparable(row[field(c)]);
        const b = comparable(params[p]);
        return op === '<='
          ? a <= b
          : op === '<'
            ? a < b
            : op === '>='
              ? a >= b
              : a > b;
      },
  ],
];

function termMatcher(term: string, params: Params): RowFilter {
  // (AFZaUUi5) `(x IS NULL OR x <= :p)` — qavs ichida OR bilan oddiy shartlar.
  const group = /^\((.+)\)$/.exec(term);
  if (group && /\s+OR\s+/.test(group[1])) {
    const parts = group[1]
      .split(/\s+OR\s+/)
      .map((part) => termMatcher(part.trim(), params));
    return (row) => parts.some((part) => part(row));
  }
  for (const [pattern, build] of TERMS) {
    const m = pattern.exec(term);
    if (m) return build(m, params);
  }
  throw new Error(`extra-cost-kit: tanilmagan shart «${term}»`);
}

function whereMatcher(sql: string, params: Params): RowFilter {
  const terms = sql
    .split(/\s+AND\s+/)
    .map((raw) => termMatcher(raw.trim(), params));
  return (row) => terms.every((t) => t(row));
}

/**
 * (AFZaUUi5) `auto_approve_from` berilmasa — `createdAt`: skaner yangi so'rovni
 * birinchi tikda shunday belgilaydi. Belgilanmagan (NULL) qator kerak bo'lsa —
 * `auto_approve_from: null` aniq beriladi.
 */
const withDefaults = (row: Params): Params => ({
  ...row,
  auto_approve_from:
    'auto_approve_from' in row ? row.auto_approve_from : row.createdAt,
});

/** TypeORM `find({ where })` — oddiy tenglik (`isDeleted`, `status`, ...). */
function findMatcher(where?: Params): RowFilter {
  return (row) =>
    Object.entries(where ?? {}).every(
      ([key, value]) => String(row[key]) === String(value),
    );
}

export function extraCostApprovalTable(
  initial: Array<Partial<ExtraCostApprovalRow>> = [],
) {
  let seq = 0;
  const rows: ExtraCostApprovalRow[] = initial.map((row) =>
    withDefaults({
      isDeleted: false,
      createdAt: new Date('2026-09-10T10:00:00.000Z'),
      ...clone(row),
    }),
  ) as ExtraCostApprovalRow[];
  /** Har bir UPDATE: nima yozildi, qaysi qatorlarga tegdi. */
  const updates: Array<{ patch: Params; ids: string[] }> = [];

  /** UPDATE (`update().set().where()…execute()`) va SELECT (`getMany`). */
  const queryBuilder = () => {
    let patch: Params | null = null;
    let limit = Infinity;
    let order: { key: string; direction: number } = {
      key: 'createdAt',
      direction: 1,
    };
    const conditions: RowFilter[] = [];
    const matching = () =>
      rows
        .filter((row) => conditions.every((c) => c(row)))
        .sort(
          (a, b) =>
            (comparable(a[order.key]) - comparable(b[order.key])) *
            order.direction,
        );
    const qb = {
      update: () => qb,
      set: (value: Params) => {
        patch = value;
        return qb;
      },
      where: (sql: string, params: Params = {}) => {
        conditions.push(whereMatcher(sql, params));
        return qb;
      },
      andWhere: (sql: string, params: Params = {}) => {
        conditions.push(whereMatcher(sql, params));
        return qb;
      },
      returning: () => qb,
      orderBy: (column: string, direction: 'ASC' | 'DESC' = 'ASC') => {
        order = {
          key: field(column),
          direction: direction === 'DESC' ? -1 : 1,
        };
        return qb;
      },
      take: (n: number) => {
        limit = n;
        return qb;
      },
      getMany: () => Promise.resolve(matching().slice(0, limit).map(clone)),
      execute: jest.fn(() => {
        const hit = matching();
        // Xom SQL qiymati: `() => '"createdAt"'` — shu qatorning ustuni,
        // boshqasi (`now()`) — hozirgi vaqt.
        const raw = (value: () => string) => {
          const column = /^"(\w+)"$/.exec(value());
          return column
            ? (row: ExtraCostApprovalRow) => row[field(column[1])]
            : () => new Date();
        };
        const resolved = Object.fromEntries(
          Object.entries(patch ?? {}).map(([key, value]) => [
            key,
            typeof value === 'function' ? raw(value as () => string) : value,
          ]),
        );
        for (const row of hit) {
          for (const [key, value] of Object.entries(resolved)) {
            row[key] =
              typeof value === 'function'
                ? (value as (r: ExtraCostApprovalRow) => unknown)(row)
                : value;
          }
        }
        updates.push({
          patch: Object.fromEntries(
            Object.entries(patch ?? {}).map(([key, value]) => [
              key,
              typeof value === 'function' ? (value as () => string)() : value,
            ]),
          ),
          ids: hit.map((row) => row.id),
        });
        // RETURNING — Postgres kabi yangilangan qator (GykuOz8f: kuryerga
        // xabar matni shu qatordan yasaladi).
        return Promise.resolve({
          raw: hit.map((row) => clone(row)),
          affected: hit.length,
        });
      }),
    };
    return qb;
  };

  const repo = {
    rows,
    updates,
    findOne: jest.fn((options?: { where?: Params }) => {
      const found = rows
        .filter(findMatcher(options?.where))
        .sort((a, b) => comparable(b.createdAt) - comparable(a.createdAt));
      return Promise.resolve(found[0] ? clone(found[0]) : null);
    }),
    find: jest.fn((options?: { where?: Params }) =>
      Promise.resolve(rows.filter(findMatcher(options?.where)).map(clone)),
    ),
    create: jest.fn((entity: Params) => ({ ...entity })),
    save: jest.fn((entity: Params) => {
      const existing = entity.id
        ? rows.find((row) => row.id === String(entity.id))
        : undefined;
      if (existing) {
        Object.assign(existing, entity);
        return Promise.resolve(clone(existing));
      }
      const row = withDefaults({
        id: ++seq === 1 ? 'approval-new' : `approval-new-${seq}`,
        createdAt: new Date('2026-09-10T10:00:00.000Z'),
        updatedAt: new Date('2026-09-10T10:00:00.000Z'),
        isDeleted: false,
        ...entity,
      }) as unknown as ExtraCostApprovalRow;
      rows.push(row);
      return Promise.resolve(clone(row));
    }),
    createQueryBuilder: jest.fn(queryBuilder),
    /** Jadvaldagi jonli qator (tekshiruvlar uchun). */
    row: (id: string) => rows.find((row) => row.id === String(id)),
    /** Tranzaksiya boshi: qaytaruvchi funksiya (rollback) beradi. */
    begin(): () => void {
      const snapshot = clone(rows);
      return () => {
        rows.splice(0, rows.length, ...snapshot);
      };
    },
    /** Tranzaksiya: muvaffaqiyatsiz bo'lsa jadval holati qaytariladi. */
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      const rollback = repo.begin();
      try {
        return await work();
      } catch (error) {
        rollback();
        throw error;
      }
    },
  };
  return repo;
}

export type ExtraCostApprovalTable = ReturnType<typeof extraCostApprovalTable>;

/**
 * `order_tracking` dan «so'rovdan keyin holat o'zgarganmi» so'rovi
 * (`extraCostStatusChangedSince`) — `changedTo`: yangi holat yoki `null`
 * (spec o'rtasida o'zgartirish mumkin).
 */
export function extraCostTrackingRepo(changedTo: string | null = null) {
  const state = { changedTo };
  const qb = {
    innerJoin: () => qb,
    select: () => qb,
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    limit: () => qb,
    getRawOne: jest.fn(() =>
      Promise.resolve(
        state.changedTo ? { to_status: state.changedTo } : undefined,
      ),
    ),
  };
  return { state, qb, createQueryBuilder: jest.fn(() => qb) };
}

/**
 * EntityManager: so'rovlar jadvali, `order_tracking` darvozasi va (berilsa)
 * buyurtma repozitoriyasi.
 */
export function extraCostManager(params: {
  table: ExtraCostApprovalTable;
  changedTo?: string | null;
  orderRepo?: unknown;
}) {
  const tracking = extraCostTrackingRepo(params.changedTo ?? null);
  return {
    tracking,
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OrderExtraCostApproval) return params.table;
      if (entity === OrderTracking) return tracking;
      if (entity === Order) return params.orderRepo ?? {};
      return {};
    }),
  };
}

/**
 * (GykuOz8f) `dataSource.transaction(work)` — rad etish va yopilish xabari
 * bilan bitta tranzaksiya: `work` shu menejer bilan; xato bo'lsa jadval
 * holati qaytadi.
 */
export function extraCostTransaction(
  manager: ReturnType<typeof extraCostManager>,
  table: ExtraCostApprovalTable,
) {
  return jest.fn(<T>(work: (tx: unknown) => Promise<T>) =>
    table.transaction(() => work(manager)),
  );
}

/**
 * `DataSource`: `createQueryRunner()` shu menejer bilan; rollback jadvalni
 * tranzaksiya boshidagi holatiga qaytaradi. `manager` — qulfsiz o'qishlar
 * (tasdiq darvozasining tezkor yo'li).
 */
export function extraCostDataSource(
  manager: ReturnType<typeof extraCostManager>,
  table: ExtraCostApprovalTable,
) {
  let rollback: (() => void) | null = null;
  const runner = {
    manager,
    connect: jest.fn(),
    startTransaction: jest.fn(() => {
      rollback = table.begin();
    }),
    commitTransaction: jest.fn(() => {
      rollback = null;
    }),
    rollbackTransaction: jest.fn(() => {
      rollback?.();
      rollback = null;
    }),
    release: jest.fn(),
  };
  return {
    manager,
    runner,
    createQueryRunner: jest.fn(() => runner),
    transaction: extraCostTransaction(manager, table),
  };
}

/**
 * Market tasdig'ini qayta ijro — `approveExtraCostApproval` sotish / bekor /
 * qisman sotishga beradigan 5-parametr. Claim (darvoza + shartli UPDATE)
 * alohida spec'larda tekshiriladi; pul va sabab spec'lari uchun u shu
 * xizmatda o'tkazib yuboriladi.
 */
export function extraCostReplay(service: object, id = 'approval-replay') {
  jest
    .spyOn(
      service as Record<string, () => Promise<void>>,
      'applyExtraCostApprovalsOnExecution',
    )
    .mockResolvedValue(undefined);
  return {
    extraCostApproval: {
      id,
      patch: {
        decided_by_user_id: '501',
        decided_at: new Date('2026-09-10T11:00:00.000Z'),
        decision_comment: null,
        auto_approved: false,
      },
    },
  };
}
