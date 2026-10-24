/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/no-implied-eval */
import { SearchServiceService } from './search-service.service';

/**
 * ISeuwhfr — global qidiruv (`search.query`): market operatori buyurtma
 * hujjatlarini BIRIKTIRILGAN MARKETI bo'yicha ko'radi. Ilgari doira faqat
 * so'rovchining o'z id si (market/kuryer/mijoz) edi — operator id si hech
 * qaysi buyurtmaning `market_id` si emas, natijada operator o'z marketining
 * buyurtmasini ham topmasdi.
 *
 * Buyurtma doirasi bandi (SQL) JS ifodaga o'giriladi va indeks hujjatlariga
 * qo'llanadi — qaysi hujjat CHIQISHI tekshiriladi. Noma'lum SQL bo'lagi —
 * xato (band o'zgarsa test uni ham yangilashni talab qiladi).
 */

type Doc = {
  id: string;
  source: string;
  type: string;
  sourceId: string;
  title: string;
  metadata: Record<string, unknown> | null;
};

const SCOPE_TOKENS: Array<[RegExp, string]> = [
  [/doc\.source <> :(\w+)/g, 'doc.source !== p.$1'],
  [/doc\.source NOT IN \(:\.\.\.(\w+)\)/g, '!p.$1.includes(doc.source)'],
  [
    /doc\.metadata->>'(\w+)' = :(\w+)/g,
    "(doc.metadata?.['$1'] ?? null) === p.$2",
  ],
  [/:(\w+) <> ''/g, "p.$1 !== ''"],
  [/\bOR\b/g, '||'],
  [/\bAND\b/g, '&&'],
];

function compile(sql: string, params: Record<string, unknown>) {
  let js = sql.replace(/\s+/g, ' ');
  for (const [re, to] of SCOPE_TOKENS) js = js.replace(re, to);
  if (/:\w|->>|\bIN\b|ILIKE|ANY\(/.test(js)) {
    throw new Error(`noma'lum SQL bo'lagi: ${js}`);
  }
  const fn = new Function('doc', 'p', `return (${js});`) as (
    d: Doc,
    p: Record<string, unknown>,
  ) => boolean;
  return (doc: Doc) => fn(doc, params);
}

function setup(docs: Doc[]) {
  const filters: Array<(doc: Doc) => boolean> = [];
  const clauses: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const qb: Record<string, any> = {};
  const chain = () => qb;
  Object.assign(qb, {
    where: chain,
    andWhere: (sql: string, params: Record<string, unknown> = {}) => {
      clauses.push({ sql, params });
      // isDeleted/type/q bandlari bu testda ishlatilmaydi.
      if (!/isDeleted|doc\.type =|qLike/.test(sql)) {
        filters.push(compile(sql, params));
      }
      return qb;
    },
    orderBy: chain,
    skip: chain,
    take: chain,
    getManyAndCount: async () => {
      const found = docs.filter((doc) => filters.every((f) => f(doc)));
      return [found, found.length];
    },
  });
  const repo = { createQueryBuilder: jest.fn(() => qb) };
  const service = new SearchServiceService(repo as never);
  return { service, clauses };
}

const order = (id: string, metadata: Record<string, unknown>): Doc => ({
  id: `doc-${id}`,
  source: 'order',
  type: 'order',
  sourceId: id,
  title: `Order #${id}`,
  metadata,
});

const DOCS: Doc[] = [
  order('101', { market_id: '7', customer_id: '50', courier_id: '30' }),
  order('102', { market_id: '7', customer_id: '51' }),
  order('201', { market_id: '8', customer_id: '52' }),
  order('202', { market_id: '8', courier_id: '40' }),
  {
    id: 'doc-p1',
    source: 'catalog',
    type: 'product',
    sourceId: '900',
    title: 'Telefon',
    metadata: null,
  },
  {
    id: 'doc-u1',
    source: 'identity',
    type: 'customer',
    sourceId: '50',
    title: 'Ali',
    metadata: { phone_number: '+998901112233' },
  },
];

const ids = (res: any) =>
  (res.data.items as Doc[]).map((d) => d.sourceId).sort();

describe('search.query — market operatori doirasi (ISeuwhfr)', () => {
  it('⭐ operator (market #7) — faqat #7 buyurtmalari + umumiy hujjatlar; PII yo‘q', async () => {
    const { service } = setup(DOCS);
    const res = await service.query({
      requester: { id: '77', roles: ['market_operator'], market_id: '7' },
    });
    expect(ids(res)).toEqual(['101', '102', '900']);
    // Imtiyozsiz proyeksiya — metadata/content yo'q.
    expect(res.data.items[0]).not.toHaveProperty('metadata');
  });

  it('boshqa market (#8) buyurtmasi operatorga chiqmaydi', async () => {
    const { service } = setup(DOCS);
    const res = await service.query({
      requester: { id: '77', roles: ['market_operator'], market_id: '7' },
    });
    expect(ids(res)).not.toContain('201');
    expect(ids(res)).not.toContain('202');
  });

  it('market biriktirilmagan / noto‘g‘ri market_id — buyurtma chiqmaydi (fail-closed)', async () => {
    for (const market_id of ['', null, undefined, "7' OR '1'='1", 'abc']) {
      const { service, clauses } = setup(DOCS);
      const res = await service.query({
        requester: { id: '77', roles: ['market_operator'], market_id },
      });
      expect(ids(res)).toEqual(['900']);
      expect(JSON.stringify(clauses)).not.toContain('operatorMarketId');
    }
  });

  it('market_id faqat market_operator rolida hisobga olinadi (market/kuryer — e’tiborsiz)', async () => {
    const market = setup(DOCS);
    const res = await market.service.query({
      requester: { id: '8', roles: ['market'], market_id: '7' },
    });
    expect(ids(res)).toEqual(['201', '202', '900']);

    const courier = setup(DOCS);
    const res2 = await courier.service.query({
      requester: { id: '30', roles: ['courier'], market_id: '8' },
    });
    expect(ids(res2)).toEqual(['101', '900']);
  });

  it('admin — doira yo‘q (o‘zgarmagan)', async () => {
    const { service, clauses } = setup(DOCS);
    const res = await service.query({
      requester: { id: '1', roles: ['admin'], market_id: '7' },
    });
    expect(ids(res)).toEqual(['101', '102', '201', '202', '50', '900']);
    expect(clauses.some((c) => c.sql.includes('orderSource'))).toBe(false);
  });

  it('bo‘sh market_id dagi SQL avvalgi band bilan bir xil (regressiya yo‘q)', async () => {
    const { service, clauses } = setup(DOCS);
    await service.query({ requester: { id: '7', roles: ['market'] } });
    const scope = clauses.find((c) => c.sql.includes('orderSource'));
    expect(scope?.params).toEqual({ orderSource: 'order', rid: '7' });
    expect(scope?.sql).not.toContain('operatorMarketId');
  });
});
