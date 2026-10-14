/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { Brackets, FindOperator } from 'typeorm';
import { Roles } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * zfPNDCCr — identity QIDIRUVI telefon formatidan qat'i nazar (prod testi
 * 2026-10-09, 2-tur): saqlangan '+998330991009' mijoz '0330991009' yoki
 * '+998 33 099 10 09' bilan qidirilsa 0 natija berardi.
 *
 * `searchCustomers` — `identity.customer.search` RPC: buyurtmalar ro'yxati
 * qidiruvi (order-service `search` filtri) ham shu yerdan o'tadi.
 *
 * Testlar SQL bandlarini yozib olib, ularni qatorlarga JS'da qo'llaydi
 * (ILIKE/LIKE va `regexp_replace(col, '[^0-9]', '', 'g') LIKE`): qaysi
 * mijoz TOPILISHI tekshiriladi, faqat SQL matni emas. Noma'lum SQL — xato.
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

/** Bitta SQL bandini qatorga qo'llaydi (faqat qidiruvda ishlatiladiganlari). */
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

/**
 * QueryBuilder soxtasi: `Brackets` ichidagi where/orWhere (OR) bandlarini
 * yozib oladi va get* chaqiruvida `rows` ni shu bandlar bilan filtrlaydi.
 * Tashqi andWhere (isDeleted, role...) e'tiborsiz — `rows` allaqachon
 * kerakli roldagi qatorlar.
 */
function fakeQb(rows: Row[]) {
  const searchClauses: Clause[] = [];
  const inner: Row = {};
  inner.where = (sql: string, params?: Row) => {
    searchClauses.push([sql, params]);
    return inner;
  };
  inner.orWhere = inner.where;
  inner.andWhere = inner.where;
  const filtered = () =>
    searchClauses.length
      ? rows.filter((row) => searchClauses.some((c) => evalClause(c, row)))
      : rows;
  const qb: Row = {};
  const chain = () => qb;
  Object.assign(qb, {
    where: (arg: unknown) => {
      if (arg instanceof Brackets) arg.whereFactory(inner as never);
      return qb;
    },
    andWhere: (arg: unknown) => {
      if (arg instanceof Brackets) arg.whereFactory(inner as never);
      return qb;
    },
    orderBy: chain,
    skip: chain,
    take: chain,
    clone: chain,
    getMany: async () => filtered(),
    getManyAndCount: async () => [filtered(), filtered().length],
    getCount: async () => filtered().length,
    // nFmup26a: findAllAdmins meta — rol kesimi GROUP BY (getRawMany).
    select: chain,
    addSelect: chain,
    groupBy: chain,
    getRawMany: async () => [],
  });
  return { qb, searchClauses };
}

function makeService(rows: Row[]) {
  const { qb, searchClauses } = fakeQb(rows);
  const svc: any = Object.create(UserServiceService.prototype);
  svc.users = { createQueryBuilder: jest.fn(() => qb) };
  svc.sanitize = (u: Row) => u;
  svc.getRegionsByIds = async () => new Map();
  return { svc, searchClauses };
}

const CUSTOMERS: Row[] = [
  { id: '50', name: 'TEST kanonik', phone_number: '+998330991009' },
  // Eski (normallashtirilmagan) yozuvlar — bular ham topilishi kerak.
  { id: '51', name: 'TEST eski probelli', phone_number: '+998 33 099 10 09' },
  { id: '52', name: 'TEST eski 998', phone_number: '998330991009' },
  { id: '53', name: 'TEST eski 9 xona', phone_number: '330991009' },
  // Begona mijozlar — telefon qidiruvida CHIQMASLIGI kerak.
  { id: '60', name: 'Ali Valiyev', phone_number: '+998901112233' },
  { id: '61', name: 'Yaqin raqam', phone_number: '+998 90 330 99 10' },
];

const ids = (res: { data: Row[] }) => res.data.map((r) => r.id).sort();

describe('searchCustomers — telefon formatidan qat`i nazar (zfPNDCCr)', () => {
  it.each(['0330991009', '+998 33 099 10 09', '330991009', '998330991009'])(
    "⭐ %p → '+998330991009' mijoz (va uning eski shakldagi yozuvlari) topiladi",
    async (search) => {
      const { svc } = makeService(CUSTOMERS);
      const res = await svc.searchCustomers(search);
      expect(ids(res)).toEqual(['50', '51', '52', '53']);
    },
  );

  it.each(['+998330991009', '+998 (33) 099-10-09', '  0330991009  '])(
    '%p — boshqa yozilishlar ham',
    async (search) => {
      const { svc } = makeService(CUSTOMERS);
      expect(ids(await svc.searchCustomers(search))).toEqual([
        '50',
        '51',
        '52',
        '53',
      ]);
    },
  );

  it('telefon bandi — milliy 9 raqam, parametr orqali', async () => {
    const { svc, searchClauses } = makeService(CUSTOMERS);
    await svc.searchCustomers('+998 33 099 10 09');
    expect(searchClauses).toContainEqual([
      "regexp_replace(u.phone_number, '[^0-9]', '', 'g') LIKE :phoneDigits",
      { phoneDigits: '%330991009%' },
    ]);
  });

  it("⭐ 'Ali' — avvalgidek: faqat ism/telefon ILIKE, telefon bandi YO'Q", async () => {
    const { svc, searchClauses } = makeService(CUSTOMERS);
    const res = await svc.searchCustomers('Ali');
    expect(ids(res)).toEqual(['60']);
    expect(searchClauses).toEqual([
      ['u.name ILIKE :s', { s: '%Ali%' }],
      ['u.phone_number ILIKE :s', { s: '%Ali%' }],
    ]);
  });

  it('qisman raqam (7+ raqam, formatlangan) — raqamlar ichidan', async () => {
    const { svc } = makeService(CUSTOMERS);
    // "099-10-09" xom ILIKE bilan hech qaysi yozuvga mos kelmasdi.
    expect(ids(await svc.searchCustomers('099-10-09'))).toEqual([
      '50',
      '51',
      '52',
      '53',
    ]);
  });

  it("qisqa raqam (7 dan kam) — avvalgidek xom ILIKE (telefon bandi yo'q)", async () => {
    const { svc, searchClauses } = makeService(CUSTOMERS);
    await svc.searchCustomers('1009');
    expect(searchClauses.map(([sql]) => sql)).toEqual([
      'u.name ILIKE :s',
      'u.phone_number ILIKE :s',
    ]);
  });

  it("bo'sh qidiruv — bazaga murojaat yo'q", async () => {
    const { svc } = makeService(CUSTOMERS);
    expect(await svc.searchCustomers('   ')).toEqual({
      success: true,
      data: [],
    });
    expect(svc.users.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('xodimlar ro`yxati qidiruvi — telefon formatidan qat`i nazar (zfPNDCCr)', () => {
  const STAFF: Row[] = [
    {
      id: '70',
      name: 'TEST kuryer',
      username: 'k70',
      phone_number: '+998330991009',
    },
    {
      id: '71',
      name: 'TEST eski',
      username: 'k71',
      phone_number: '+998 33 099 10 09',
    },
    { id: '72', name: 'Ali', username: 'ali', phone_number: '+998901112233' },
  ];

  const itemIds = (res: { data: { items: Row[] } }) =>
    res.data.items.map((r) => r.id).sort();

  it.each([
    ['findAllCouriers', 'courier'],
    ['findAllMarkets', 'market'],
    ['findAllAdmins', 'admin'],
  ])(
    '%s: 4 xil yozilishda ham kanonik va eski raqam topiladi',
    async (method, alias) => {
      for (const search of [
        '0330991009',
        '+998 33 099 10 09',
        '330991009',
        '998330991009',
      ]) {
        const { svc, searchClauses } = makeService(STAFF);
        const res = await svc[method]({ search });
        expect(itemIds(res)).toEqual(['70', '71']);
        expect(searchClauses).toContainEqual([
          `regexp_replace(${alias}.phone_number, '[^0-9]', '', 'g') LIKE :phoneDigits`,
          { phoneDigits: '%330991009%' },
        ]);
      }
    },
  );

  it.each(['findAllCouriers', 'findAllMarkets', 'findAllAdmins'])(
    "%s: 'Ali' — avvalgidek (telefon bandi yo'q)",
    async (method) => {
      const { svc, searchClauses } = makeService(STAFF);
      const res = await svc[method]({ search: 'Ali' });
      expect(itemIds(res)).toEqual(['72']);
      expect(searchClauses.some(([sql]) => sql.includes('regexp'))).toBe(false);
    },
  );
});

describe('findMarketOperators — telefon formatidan qat`i nazar (zfPNDCCr)', () => {
  const OPERATORS: Row[] = [
    { id: '80', name: 'TEST op', phone_number: '+998330991009' },
    { id: '81', name: 'TEST op eski', phone_number: '+998 33 099 10 09' },
    { id: '82', name: 'Ali', phone_number: '+998901112233' },
  ];

  /** TypeORM find `where` massivi (OR) — ILike va Raw operatorlari. */
  function opService() {
    const svc: any = Object.create(UserServiceService.prototype);
    const matchValue = (row: Row, key: string, expected: unknown) => {
      if (!(expected instanceof FindOperator)) return true; // base maydonlar
      if (expected.type === 'ilike') {
        return evalClause([`t.${key} ILIKE :v`, { v: expected.value }], row);
      }
      if (expected.type === 'raw') {
        const sql = (expected.getSql as (alias: string) => string)(`t.${key}`);
        return evalClause([sql, expected.objectLiteralParameters], row);
      }
      throw new Error(`unsupported operator ${expected.type}`);
    };
    svc.users = {
      findAndCount: jest.fn(async ({ where }: { where: Row | Row[] }) => {
        const clauses = Array.isArray(where) ? where : [where];
        const found = OPERATORS.filter((row) =>
          clauses.some((clause) =>
            Object.entries(clause).every(([key, expected]) =>
              matchValue(row, key, expected),
            ),
          ),
        );
        return [found, found.length];
      }),
    };
    svc.toMarketOperatorView = (row: Row) => row;
    return svc;
  }

  const req = { id: '5', roles: [Roles.MARKET] };

  it.each(['0330991009', '+998 33 099 10 09', '330991009', '998330991009'])(
    '⭐ %p → kanonik va eski raqamli operator topiladi',
    async (search) => {
      const svc = opService();
      const res = await svc.findMarketOperators('5', { search }, req);
      expect(res.data.items.map((r: Row) => r.id).sort()).toEqual(['80', '81']);
    },
  );

  it("'Ali' — avvalgidek ikki band (ism, telefon ILIKE), Raw yo'q", async () => {
    const svc = opService();
    const res = await svc.findMarketOperators('5', { search: 'Ali' }, req);
    expect(res.data.items.map((r: Row) => r.id)).toEqual(['82']);
    expect(svc.users.findAndCount.mock.calls[0][0].where).toHaveLength(2);
  });
});
