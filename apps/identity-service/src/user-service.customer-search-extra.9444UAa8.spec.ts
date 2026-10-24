/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { Brackets } from 'typeorm';
import { IdentityController } from './identity.controller';
import { UserServiceService } from './user-service.service';

/**
 * 9444UAa8 — `identity.customer.search` qo'shimcha raqam (`extra_number`)
 * bo'yicha ham (asosiy telefondagi kabi normallashtirilgan raqamlar), faqat
 * `match_extra_number: true` bilan (mijoz taklifi). Buyurtmalar ro'yxati
 * qidiruvi flag yubormaydi — natijasi o'zgarmagan. Har qatorda `matched_by`:
 * `phone` | `extra_number` | `name`.
 *
 * QueryBuilder soxtasi SQL bandlarini qatorlarga JS'da qo'llaydi (qaysi
 * mijoz TOPILISHI tekshiriladi) — user-service.phone-search.spec.ts usuli.
 */
type Row = Record<string, any>;
type Clause = [string, Row | undefined];

const likeToRegExp = (pattern: string, caseInsensitive: boolean) =>
  new RegExp(
    `^${pattern
      .split('')
      .map((ch) =>
        ch === '%'
          ? '.*'
          : ch === '_'
            ? '.'
            : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('')}$`,
    caseInsensitive ? 'is' : 's',
  );

function evalClause([sql, params]: Clause, row: Row): boolean {
  const plain = /^\w+\.(\w+) (I?LIKE) :(\w+)$/.exec(sql);
  if (plain) {
    const [, column, op, param] = plain;
    return likeToRegExp(String(params?.[param]), op === 'ILIKE').test(
      String(row[column] ?? ''),
    );
  }
  const digits =
    /^regexp_replace\(\w+\.(\w+), '\[\^0-9\]', '', 'g'\) LIKE :(\w+)$/.exec(
      sql,
    );
  if (digits) {
    const [, column, param] = digits;
    return likeToRegExp(String(params?.[param]), false).test(
      String(row[column] ?? '').replace(/[^0-9]/g, ''),
    );
  }
  throw new Error(`noma'lum SQL bandi: ${sql}`);
}

function fakeQb(rows: Row[]) {
  const searchClauses: Clause[] = [];
  const inner: Row = {};
  inner.where = (sql: string, params?: Row) => {
    searchClauses.push([sql, params]);
    return inner;
  };
  inner.orWhere = inner.where;
  const filtered = () =>
    rows.filter((row) => searchClauses.some((c) => evalClause(c, row)));
  const qb: Row = {};
  const chain = () => qb;
  Object.assign(qb, {
    where: chain,
    andWhere: (arg: unknown) => {
      if (arg instanceof Brackets) arg.whereFactory(inner as never);
      return qb;
    },
    orderBy: chain,
    take: chain,
    getMany: async () => filtered(),
  });
  return { qb, searchClauses };
}

function makeService(rows: Row[]) {
  const { qb, searchClauses } = fakeQb(rows);
  const svc: any = Object.create(UserServiceService.prototype);
  svc.users = { createQueryBuilder: jest.fn(() => qb) };
  return { svc, searchClauses };
}

const CUSTOMERS: Row[] = [
  // Asosiy telefon boshqa, qo'shimcha raqam — qidirilayotgan raqam.
  {
    id: '70',
    name: 'Qo`shimchasi mos',
    phone_number: '+998991330152',
    extra_number: '+998903456744',
  },
  // Qo'shimcha raqam eski (normallashtirilmagan) shaklda.
  {
    id: '71',
    name: 'Eski qo`shimcha',
    phone_number: '+998991330153',
    extra_number: '90 345 67 44',
  },
  // Asosiy telefon mos (qo'shimchasi ham) — `phone` ustun.
  {
    id: '72',
    name: 'Asosiysi mos',
    phone_number: '+998903456744',
    extra_number: '+998903456744',
  },
  // Begona.
  {
    id: '73',
    name: 'Ali Valiyev',
    phone_number: '+998901112233',
    extra_number: null,
  },
];

const byId = (res: { data: Row[] }) =>
  Object.fromEntries(res.data.map((r) => [r.id, r.matched_by]));

describe('9444UAa8 — searchCustomers qo`shimcha raqam bo`yicha', () => {
  it.each(['+998 90 345 67 44', '0903456744', '903456744', '998903456744'])(
    '⭐ %p (match_extra_number) — qo`shimcha raqam ham topiladi, matched_by to`g`ri',
    async (search) => {
      const { svc } = makeService(CUSTOMERS);

      const res = await svc.searchCustomers(search, 50, {
        matchExtraNumber: true,
      });

      expect(byId(res)).toEqual({
        '70': 'extra_number',
        '71': 'extra_number',
        '72': 'phone',
      });
    },
  );

  it('qo`shimcha raqam bandi — normallashtirilgan 9 raqam, parametr orqali', async () => {
    const { svc, searchClauses } = makeService(CUSTOMERS);
    await svc.searchCustomers('+998 90 345 67 44', 50, {
      matchExtraNumber: true,
    });
    expect(searchClauses).toContainEqual([
      "regexp_replace(u.extra_number, '[^0-9]', '', 'g') LIKE :extraDigits",
      { extraDigits: '%903456744%' },
    ]);
  });

  it('⭐ flagsiz (buyurtmalar ro`yxati qidiruvi) — o`zgarmagan: faqat asosiy telefon', async () => {
    const { svc, searchClauses } = makeService(CUSTOMERS);

    const res = await svc.searchCustomers('+998 90 345 67 44', 50);

    expect(byId(res)).toEqual({ '72': 'phone' });
    expect(searchClauses.map(([sql]) => sql)).not.toContain(
      "regexp_replace(u.extra_number, '[^0-9]', '', 'g') LIKE :extraDigits",
    );
  });

  it('matnli qidiruv (`Ali`) — qo`shimcha raqam bandi yo`q, matched_by name', async () => {
    const { svc, searchClauses } = makeService(CUSTOMERS);
    const res = await svc.searchCustomers('Ali', 50, {
      matchExtraNumber: true,
    });
    expect(byId(res)).toEqual({ '73': 'name' });
    expect(searchClauses).toHaveLength(2);
  });

  it('qisqa raqam (7 dan kam) — qo`shimcha raqam bandi yo`q', async () => {
    const { svc, searchClauses } = makeService(CUSTOMERS);
    await svc.searchCustomers('6744', 50, { matchExtraNumber: true });
    expect(searchClauses.map(([sql]) => sql)).toEqual([
      'u.name ILIKE :s',
      'u.phone_number ILIKE :s',
    ]);
  });
});

describe('9444UAa8 — identity.customer.search RPC flagi', () => {
  it.each([
    [true, true],
    ['true', false],
    [1, false],
    [undefined, false],
  ])(
    'match_extra_number=%p → matchExtraNumber=%p (faqat qat`iy true)',
    async (flag, expected) => {
      const searchCustomers = jest.fn().mockResolvedValue({ data: [] });
      const controller = Object.create(IdentityController.prototype);
      controller.userService = { searchCustomers };
      controller.executeAndAck = (_ctx: unknown, fn: () => unknown) => fn();

      await controller.searchCustomers(
        { search: '903456744', limit: 10, match_extra_number: flag },
        {} as never,
      );

      expect(searchCustomers).toHaveBeenCalledWith('903456744', 10, {
        matchExtraNumber: expected,
      });
    },
  );
});
