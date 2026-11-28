import {
  allocatePaid,
  computeAccrual,
  planShareTermChange,
  planStartChange,
  termForDay,
  type TermRow,
} from './investor-accrual';

/**
 * Investor ulushi (ega 2026-11-28, BeePost naqshi): har ish kuni o'sha kungi
 * shart bilan; shartdan oldingi kunlar hisobga kirmaydi; 'net' — sof foyda,
 * 'gross' — daromad.
 */
const term = (over: Partial<TermRow>): TermRow => ({
  id: '1',
  share_percent: 10,
  profit_basis: 'net',
  effective_from: '2026-11-01',
  effective_to: null,
  ...over,
});

describe('termForDay', () => {
  const terms = [
    term({ id: '1', effective_from: '2026-11-01', effective_to: '2026-11-15' }),
    term({ id: '2', effective_from: '2026-11-15', share_percent: 20 }),
  ];
  it.each([
    ['2026-10-31', null],
    ['2026-11-01', '1'],
    ['2026-11-14', '1'],
    ['2026-11-15', '2'],
    ['2027-01-01', '2'],
  ])('%s → %s', (day, id) => {
    expect(termForDay(terms, day)?.id ?? null).toBe(id);
  });
});

describe('computeAccrual', () => {
  const days = [
    { period: '2026-10-31', gross: 5000, net: 4000 }, // shartdan oldin
    { period: '2026-11-01', gross: 1000, net: 600 },
    { period: '2026-11-20', gross: 2000, net: -500 }, // zarar kuni
    { period: '2026-12-02', gross: 3000, net: 1000.55 },
  ];

  it('⭐ sof foydadan: shart boshidan, zarar kuni ham kamaytiradi', () => {
    const result = computeAccrual([term({})], days);
    // 60 + (−50) + 100.055 → 100.06 (tiyinda yaxlitlash)
    expect(result.totalCents).toBe(6000 - 5000 + 10006);
    expect(result.months).toEqual([
      {
        month: '2026-11',
        basisCents: 60000 - 50000,
        accruedCents: 1000,
        sharePercent: 10,
        profitBasis: 'net',
      },
      {
        month: '2026-12',
        basisCents: 100055,
        accruedCents: 10006,
        sharePercent: 10,
        profitBasis: 'net',
      },
    ]);
  });

  it('⭐ daromaddan (gross): xarajat ayrilmaydi', () => {
    const result = computeAccrual([term({ profit_basis: 'gross' })], days);
    expect(result.totalCents).toBe(10000 + 20000 + 30000);
  });

  it('shart o`zgarsa — har kun o`z sharti bilan (o`tgan kunlar o`zgarmaydi)', () => {
    const result = computeAccrual(
      [
        term({ id: '1', effective_to: '2026-12-01' }),
        term({
          id: '2',
          effective_from: '2026-12-01',
          share_percent: 50,
          profit_basis: 'gross',
        }),
      ],
      days,
    );
    expect(result.months.map((m) => [m.month, m.accruedCents])).toEqual([
      ['2026-11', 1000],
      ['2026-12', 150000],
    ]);
    expect(result.months[1]).toMatchObject({
      sharePercent: 50,
      profitBasis: 'gross',
    });
  });

  it('shart yo`q — hech narsa hisoblanmaydi', () => {
    expect(computeAccrual([], days)).toEqual({
      months: [],
      totalCents: 0,
      totalBasisCents: 0,
    });
  });
});

describe('allocatePaid (FIFO)', () => {
  const months = [
    { month: '2026-09', accruedCents: 100 },
    { month: '2026-10', accruedCents: -40 },
    { month: '2026-11', accruedCents: 300 },
  ];
  it('eski oy birinchi yopiladi, zarar oyi to`lov olmaydi', () => {
    expect([...allocatePaid(months, 250)]).toEqual([
      ['2026-09', 100],
      ['2026-10', 0],
      ['2026-11', 150],
    ]);
  });
  it('ortiqcha to`lov hech qaysi oyga tushmaydi', () => {
    expect([...allocatePaid(months, 1000)]).toEqual([
      ['2026-09', 100],
      ['2026-10', 0],
      ['2026-11', 300],
    ]);
  });
});

describe('planShareTermChange', () => {
  const change = (over: Partial<TermRow> = {}) => ({
    share_percent: 10,
    profit_basis: 'net' as const,
    effective_from: '2026-11-01',
    ...over,
  });

  it('shart yo`q — yangi ochiq shart', () => {
    expect(planShareTermChange([], change())).toEqual({
      kind: 'apply',
      updates: [],
      insert: change(),
    });
  });

  it('⭐ keyingi sana — joriy shart yopiladi, yangisi ochiladi', () => {
    const plan = planShareTermChange(
      [term({ id: '7' })],
      change({ share_percent: 15, effective_from: '2026-12-01' }),
    );
    expect(plan).toEqual({
      kind: 'apply',
      updates: [{ id: '7', patch: { effective_to: '2026-12-01' } }],
      insert: change({ share_percent: 15, effective_from: '2026-12-01' }),
    });
  });

  it('keyingi sana, qiymatlar o`zgarmagan — hech narsa', () => {
    expect(
      planShareTermChange([term({})], change({ effective_from: '2026-12-01' })),
    ).toEqual({ kind: 'noop' });
  });

  it('⭐ ayni sana yoki oldin — joriy shart joyida tuzatiladi (asos)', () => {
    const plan = planShareTermChange(
      [term({ id: '7' })],
      change({ profit_basis: 'gross', effective_from: '2026-10-20' }),
    );
    expect(plan).toEqual({
      kind: 'apply',
      updates: [
        {
          id: '7',
          patch: {
            share_percent: 10,
            profit_basis: 'gross',
            effective_from: '2026-10-20',
          },
        },
      ],
      insert: null,
    });
  });

  it('oldingi shart bor — uning oxiri suriladi, boshidan oldinga o`tilmaydi', () => {
    const terms = [
      term({ id: '1', effective_to: '2026-12-01' }),
      term({ id: '2', effective_from: '2026-12-01', share_percent: 20 }),
    ];
    const moved = planShareTermChange(
      terms,
      change({ share_percent: 25, effective_from: '2026-11-20' }),
    );
    expect(moved).toMatchObject({
      kind: 'apply',
      updates: [
        { id: '1', patch: { effective_to: '2026-11-20' } },
        { id: '2', patch: { effective_from: '2026-11-20', share_percent: 25 } },
      ],
    });
    expect(
      planShareTermChange(terms, change({ effective_from: '2026-11-01' })),
    ).toMatchObject({ kind: 'error' });
  });
});

describe('planStartChange («Investorlik sanasi»)', () => {
  it('birinchi shart boshi oldinga ham, orqaga ham suriladi', () => {
    expect(planStartChange([term({ id: '3' })], '2026-11-05')).toEqual({
      kind: 'apply',
      updates: [{ id: '3', patch: { effective_from: '2026-11-05' } }],
      insert: null,
    });
    expect(planStartChange([term({})], '2026-11-01')).toEqual({
      kind: 'noop',
    });
  });
  it('shart yo`q yoki birinchi shart tugashidan keyin — xato', () => {
    expect(planStartChange([], '2026-11-01')).toMatchObject({ kind: 'error' });
    expect(
      planStartChange(
        [
          term({ effective_to: '2026-11-10' }),
          term({ id: '2', effective_from: '2026-11-10' }),
        ],
        '2026-11-10',
      ),
    ).toMatchObject({ kind: 'error' });
  });
});
