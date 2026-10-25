/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/no-implied-eval */
import { SearchServiceService } from './search-service.service';

/**
 * hGcR8kio — logist global qidiruvi (buyurtma, mijoz, telefon) — faqat o'z
 * viloyatlari (ega LG-S2/LG-S3), moliyaviy natijalarsiz.
 *
 * Avval logist imtiyozsiz rol sifatida faqat market_id/courier_id/
 * customer_id = o'zi bo'lgan buyurtmani ko'rardi — qidiruv deyarli doim bo'sh.
 * Endi: o'z viloyatidagi buyurtma, shu viloyatda buyurtmasi bor (yoki
 * viloyati shu) mijoz, o'z viloyati pochtasi, viloyat/tuman nomlari; xodim
 * PII'si, boshqa viloyat va boshqa manbalar — yo'q.
 *
 * Doira bandi (SQL) JS ifodaga o'giriladi va indeks hujjatlariga qo'llanadi —
 * qaysi hujjat CHIQISHI tekshiriladi. Noma'lum SQL bo'lagi — xato.
 */
type Doc = {
  id: string;
  source: string;
  type: string;
  sourceId: string;
  title: string;
  isDeleted?: boolean;
  metadata: Record<string, unknown> | null;
};

const EXISTS_RE =
  /EXISTS \(SELECT 1 FROM "search_schema"\."search_documents" "logist_order" WHERE "logist_order"\."source" = :logistOrderSource AND "logist_order"\."is_deleted" = false AND "logist_order"\."metadata"->>'customer_id' = "doc"\."sourceId" AND "logist_order"\."metadata"->>'region_id' IN \(:\.\.\.logistRegionIds\)\)/g;

const SCOPE_TOKENS: Array<[RegExp, string]> = [
  [EXISTS_RE, 'p.__hasOrderInRegions(doc)'],
  [/doc\.source = :(\w+)/g, 'doc.source === p.$1'],
  [/doc\.type = :(\w+)/g, 'doc.type === p.$1'],
  [/doc\.type IN \(:\.\.\.(\w+)\)/g, 'p.$1.includes(doc.type)'],
  [
    /doc\.metadata->>'(\w+)' IN \(:\.\.\.(\w+)\)/g,
    "p.$2.includes(doc.metadata?.['$1'] ?? null)",
  ],
  [/\bOR\b/g, '||'],
  [/\bAND\b/g, '&&'],
];

function compile(
  sql: string,
  params: Record<string, unknown>,
  docs: Doc[],
): (doc: Doc) => boolean {
  let js = sql.replace(/\s+/g, ' ');
  for (const [re, to] of SCOPE_TOKENS) js = js.replace(re, to);
  if (/:\w|->>|\bIN\b|ILIKE|ANY\(|EXISTS|SELECT/.test(js)) {
    throw new Error(`noma'lum SQL bo'lagi: ${js}`);
  }
  const regionIds = (params.logistRegionIds as string[] | undefined) ?? [];
  const p = {
    ...params,
    __hasOrderInRegions: (doc: Doc) =>
      docs.some(
        (o) =>
          o.source === 'order' &&
          !o.isDeleted &&
          o.metadata?.customer_id === doc.sourceId &&
          regionIds.includes(o.metadata?.region_id as string),
      ),
  };
  const fn = new Function('doc', 'p', `return (${js});`) as (
    d: Doc,
    p: Record<string, unknown>,
  ) => boolean;
  return (doc: Doc) => fn(doc, p);
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
      // Faqat logist doira bandi bajariladi (boshqa rollar bandlari —
      // ISeuwhfr/phone-search spec'larida).
      if (sql.includes(':logist')) {
        filters.push(compile(sql, params, docs));
      }
      return qb;
    },
    orderBy: chain,
    skip: chain,
    take: chain,
    getManyAndCount: async () => {
      // `where('doc.isDeleted = :isDeleted')` — o'chirilganlar chiqmaydi.
      const found = docs.filter(
        (doc) => !doc.isDeleted && filters.every((f) => f(doc)),
      );
      return [found, found.length];
    },
  });
  const columns: Record<string, string> = {
    source: 'source',
    isDeleted: 'is_deleted',
    metadata: 'metadata',
    sourceId: 'sourceId',
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    metadata: {
      tablePath: 'search_schema.search_documents',
      findColumnWithPropertyName: (name: string) =>
        columns[name] ? { databaseName: columns[name] } : undefined,
    },
  };
  const service = new SearchServiceService(repo as never);
  return { service, clauses };
}

const doc = (
  source: string,
  type: string,
  sourceId: string,
  metadata: Record<string, unknown> | null,
  extra: Partial<Doc> = {},
): Doc => ({
  id: `${source}-${type}-${sourceId}`,
  source,
  type,
  sourceId,
  title: `${type} ${sourceId}`,
  metadata,
  ...extra,
});

const DOCS: Doc[] = [
  // Buyurtmalar: 5 va 9 — logistniki, 7 — boshqa logistniki.
  doc('order', 'order', '100', {
    region_id: '5',
    customer_id: '50',
    total_price: 250000,
  }),
  doc('order', 'order', '101', { region_id: '9', customer_id: '52' }),
  doc('order', 'order', '200', { region_id: '7', customer_id: '51' }),
  doc(
    'order',
    'order',
    '201',
    { region_id: '5', customer_id: '53' },
    { isDeleted: true },
  ),
  // Mijozlar: 50 — 5-viloyatda buyurtmasi bor (o'z region_id si yo'q),
  // 51 — faqat 7-viloyatda, 54 — o'z region_id si 9, 53 — faqat o'chirilgan
  // buyurtmasi bor.
  doc('identity', 'customer', '50', { phone_number: '+998901234567' }),
  doc('identity', 'customer', '51', { phone_number: '+998907654321' }),
  doc('identity', 'customer', '53', { phone_number: '+998900000053' }),
  doc('identity', 'customer', '54', { region_id: '9' }),
  // Xodimlar — logistga YOPIQ (o'z viloyatida bo'lsa ham).
  doc('identity', 'courier', '26', { region_id: '5', phone_number: '+99890' }),
  doc('identity', 'market', '37', { region_id: '5' }),
  doc('identity_fallback', 'manager', '25', { region_id: '5' }),
  // Pochtalar.
  doc('logistics', 'post', '11', { region_id: '5', post_total_price: 1 }),
  doc('logistics', 'post', '12', { region_id: '7' }),
  // Geo nomlar — ochiq.
  doc('logistics', 'region', '5', null),
  doc('logistics', 'district', '501', null),
  // Boshqa manba — logistga yo'q.
  doc('catalog', 'product', '900', null),
];

const LOGIST = { id: '42', roles: ['logist'], region_ids: ['5', '9'] };

const found = (res: any) =>
  (res.data.items as Doc[]).map((d) => `${d.type}:${d.sourceId}`).sort();

describe('hGcR8kio — search.query (logist doirasi)', () => {
  it('⭐ o‘z viloyatlari: buyurtma, mijoz (buyurtma yoki region_id orqali), pochta, geo nomlar', async () => {
    const { service } = setup(DOCS);
    const res = await service.query({ requester: LOGIST });
    expect(found(res)).toEqual(
      [
        'order:100',
        'order:101',
        'customer:50',
        'customer:54',
        'post:11',
        'region:5',
        'district:501',
      ].sort(),
    );
  });

  it('⛔ boshqa viloyat buyurtmasi/mijozi/pochtasi, xodim PII, katalog — chiqmaydi', async () => {
    const { service } = setup(DOCS);
    const res = found(await service.query({ requester: LOGIST }));
    for (const hidden of [
      'order:200',
      'order:201',
      'customer:51',
      'customer:53',
      'courier:26',
      'market:37',
      'manager:25',
      'post:12',
      'product:900',
    ]) {
      expect(res).not.toContain(hidden);
    }
  });

  it('natija proyeksiyasi — summa/telefon/metadata yo‘q', async () => {
    const { service } = setup(DOCS);
    const res = await service.query({ requester: LOGIST });
    const body = JSON.stringify(res.data.items);
    expect(body).not.toContain('total_price');
    expect(body).not.toContain('phone_number');
    expect(body).not.toContain('metadata');
  });

  it('viloyat biriktirilmagan / buzuq region_ids — faqat viloyat/tuman nomlari (fail-closed)', async () => {
    for (const region_ids of [[], undefined, null, ['x'], "5' OR '1'='1"]) {
      const { service } = setup(DOCS);
      const res = await service.query({
        requester: { id: '42', roles: ['logist'], region_ids },
      });
      expect(found(res)).toEqual(['district:501', 'region:5']);
    }
  });

  it('telefon qidiruvi (zfPNDCCr) logistda ham normallashtiriladi, doira bilan birga', async () => {
    const { service, clauses } = setup(DOCS);
    await service.query({ q: '+998 90 123 45 67', requester: LOGIST });
    const q = clauses.find((c) => c.sql.includes('qLike'));
    expect(q?.params).toEqual(
      expect.objectContaining({ phoneDigits: '%901234567%' }),
    );
    expect(clauses.some((c) => c.sql.includes('logistRegionIds'))).toBe(true);
    expect(clauses.some((c) => c.sql.includes('piiSources'))).toBe(false);
  });

  it('region_ids faqat logistga ta’sir qiladi: kuryer/admin doirasi o‘zgarmagan', async () => {
    const courier = setup(DOCS);
    await courier.service.query({
      requester: { id: '26', roles: ['courier'], region_ids: ['5'] },
    } as never);
    expect(courier.clauses.some((c) => c.sql.includes('logistRegionIds'))).toBe(
      false,
    );
    expect(courier.clauses.some((c) => c.sql.includes('piiSources'))).toBe(
      true,
    );

    const admin = setup(DOCS);
    const res = await admin.service.query({
      requester: { id: '1', roles: ['admin'], region_ids: ['5'] },
    } as never);
    expect(admin.clauses.some((c) => c.sql.includes('logistRegionIds'))).toBe(
      false,
    );
    expect(res.data.items).toHaveLength(
      DOCS.filter((d) => !d.isDeleted).length,
    );
  });
});
