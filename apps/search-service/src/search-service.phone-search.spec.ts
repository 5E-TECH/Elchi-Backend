/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { SearchServiceService } from './search-service.service';

/**
 * zfPNDCCr — HEADER GLOBAL QIDIRUVI (frontend `useGlobalSearch` →
 * GET /search?q=&page=&limit= → `search.query`) telefonni normallashtirmasdi:
 * prod testida (2026-10-09, 2-tur) saqlangan '+998330991009' mijoz
 * '0330991009' yoki '+998 33 099 10 09' bilan qidirilsa 0 natija edi.
 *
 * Test `q` bandini yozib olib, uni indeks hujjatlariga JS'da qo'llaydi
 * (ILIKE, `= ANY(tags)`, `regexp_replace(metadata->>'phone_number')`):
 * qaysi hujjat TOPILISHI tekshiriladi. Noma'lum SQL bo'lagi — xato.
 */

type Doc = {
  id: string;
  source: string;
  type: string;
  sourceId: string;
  title: string;
  content: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
};

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

/** `q` bandining bitta OR qismini hujjatga qo'llaydi. */
function evalArm(arm: string, params: Record<string, unknown>, doc: Doc) {
  const like = /^doc\.(title|content) ILIKE :(\w+)$/.exec(arm);
  if (like) {
    const [, field, param] = like;
    return likeToRegExp(String(params[param]), true).test(
      String(doc[field as 'title' | 'content'] ?? ''),
    );
  }
  const tag = /^:(\w+) = ANY\(doc\.tags\)$/.exec(arm);
  if (tag) return doc.tags.includes(String(params[tag[1]]));
  const phone =
    /^regexp_replace\(doc\.metadata->>'(\w+)', '\[\^0-9\]', '', 'g'\) LIKE :(\w+)$/.exec(
      arm,
    );
  if (phone) {
    const value = doc.metadata?.[phone[1]];
    if (value === undefined || value === null) return false; // SQL NULL
    return likeToRegExp(String(params[phone[2]]), false).test(
      String(value as string).replace(/[^0-9]/g, ''),
    );
  }
  throw new Error(`noma'lum SQL bo'lagi: ${arm}`);
}

function setup(docs: Doc[]) {
  let qClause: { sql: string; params: Record<string, unknown> } | null = null;
  const qb: Record<string, any> = {};
  const chain = () => qb;
  Object.assign(qb, {
    where: chain,
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes(':qLike')) qClause = { sql, params: params ?? {} };
      return qb;
    },
    orderBy: chain,
    skip: chain,
    take: chain,
    getManyAndCount: async () => {
      if (!qClause) return [docs, docs.length];
      const { sql, params } = qClause;
      const arms = sql.replace(/^\(|\)$/g, '').split(' OR ');
      const found = docs.filter((doc) =>
        arms.some((arm) => evalArm(arm, params, doc)),
      );
      return [found, found.length];
    },
  });
  const repo = { createQueryBuilder: jest.fn(() => qb) };
  const service = new SearchServiceService(repo as never);
  return { service, getClause: () => qClause };
}

const identityDoc = (
  id: string,
  name: string,
  phone: string,
  username: string | null = null,
): Doc => ({
  id: `doc-${id}`,
  source: 'identity',
  type: 'customer',
  sourceId: id,
  title: name,
  content: [phone, username].filter(Boolean).join(' '),
  tags: ['identity', 'customer', 'active'],
  metadata: { role: 'customer', phone_number: phone, username },
});

const DOCS: Doc[] = [
  identityDoc('50', 'TEST kanonik', '+998330991009'),
  // Eski (normallashtirilmagan) indeks yozuvlari — qayta indekslamasdan ham
  // topilishi kerak.
  identityDoc('51', 'TEST eski probelli', '+998 33 099 10 09'),
  identityDoc('52', 'TEST eski 998', '998330991009'),
  identityDoc('60', 'Ali Valiyev', '+998901112233', 'ali'),
  identityDoc('61', 'Yaqin raqam', '+998 90 330 99 10'),
  {
    id: 'doc-o1',
    source: 'order',
    type: 'order',
    sourceId: '1251175',
    title: 'Order #1251175',
    content: 'new Chilonzor 5 mijoz raqami 330991009 7 50',
    tags: ['order', 'new'],
    metadata: { market_id: '7', customer_id: '50' },
  },
  {
    id: 'doc-o2',
    source: 'order',
    type: 'order',
    sourceId: '1251176',
    title: 'Order #1251176',
    content: 'new Yunusobod 7 60',
    tags: ['order', 'new'],
    metadata: { market_id: '7', customer_id: '60' },
  },
];

const ADMIN = { id: '1', roles: ['admin'] };
const sourceIds = (res: any) =>
  (res.data.items as Doc[]).map((d) => d.sourceId).sort();

describe('search.query — telefon formatidan qat`i nazar (zfPNDCCr)', () => {
  it.each(['0330991009', '+998 33 099 10 09', '330991009', '998330991009'])(
    "⭐ %p → '+998330991009' mijoz (va eski indeks yozuvlari) topiladi",
    async (q) => {
      const { service } = setup(DOCS);
      const res = await service.query({ q, requester: ADMIN });
      // 1251175 — izohida shu raqam yozilgan buyurtma (content ichida aynan).
      expect(sourceIds(res)).toEqual(['1251175', '50', '51', '52']);
    },
  );

  it('telefon bandi — milliy 9 raqam parametr orqali, avvalgi bandlar saqlanadi', async () => {
    const { service, getClause } = setup(DOCS);
    await service.query({ q: '+998 33 099 10 09', requester: ADMIN });
    expect(getClause()).toEqual({
      sql: "(doc.title ILIKE :qLike OR doc.content ILIKE :qLike OR :qRaw = ANY(doc.tags) OR doc.content ILIKE :phoneDigits OR regexp_replace(doc.metadata->>'phone_number', '[^0-9]', '', 'g') LIKE :phoneDigits)",
      params: {
        qLike: '%+998 33 099 10 09%',
        qRaw: '+998 33 099 10 09',
        phoneDigits: '%330991009%',
      },
    });
  });

  it("⭐ 'Ali' — avvalgidek: SQL va natija o'zgarmagan", async () => {
    const { service, getClause } = setup(DOCS);
    const res = await service.query({ q: 'Ali', requester: ADMIN });
    expect(getClause()).toEqual({
      sql: '(doc.title ILIKE :qLike OR doc.content ILIKE :qLike OR :qRaw = ANY(doc.tags))',
      params: { qLike: '%Ali%', qRaw: 'Ali' },
    });
    expect(sourceIds(res)).toEqual(['60']);
  });

  it("qisqa raqam (7 dan kam) — telefon bandi yo'q", async () => {
    const { service, getClause } = setup(DOCS);
    await service.query({ q: '1009', requester: ADMIN });
    expect(getClause()?.params).toEqual({ qLike: '%1009%', qRaw: '1009' });
  });

  it('privilegiyasiz rol — identity (PII) hujjatlari baribir chiqmaydi', async () => {
    const { service } = setup(DOCS);
    const andWhere = jest.fn();
    // PII filtri SQL'da qo'llanadi; bu yerda faqat u qo'shilganini tekshiramiz.
    const qbSpy = (service as any).docs.createQueryBuilder();
    const original = qbSpy.andWhere;
    qbSpy.andWhere = (sql: string, params?: Record<string, unknown>) => {
      andWhere(sql, params);
      return original(sql, params);
    };
    await service.query({
      q: '0330991009',
      requester: { id: '7', roles: ['market'] },
    });
    expect(andWhere).toHaveBeenCalledWith(
      'doc.source NOT IN (:...piiSources)',
      {
        piiSources: ['identity', 'identity_fallback'],
      },
    );
  });
});
