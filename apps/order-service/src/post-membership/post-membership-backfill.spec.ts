import {
  type BackfillPlan,
  type BackfillReport,
  type BackfillSource,
  type ExistingMembership,
  type MembershipKind,
  type PlannedStay,
  type PointerObservation,
  chunkStaysByKey,
  formatBackfillReport,
  isPristineSeed,
  normalizeObservedPostId,
  parseBackfillArgs,
  planBackfill,
  planOrderKind,
  selectByPriority,
  toRuns,
  usToIso,
} from './post-membership-backfill';

/**
 * Pochta ↔ buyurtma tarixi backfill'i — sof mantiq (kuzatuvlar → yugurishlar
 * → yopiq turishlar). DB qismi `post-membership.pg.spec.ts` da.
 */
const CUTOFF = 1_000_000;

function obs(
  source: BackfillSource,
  seq: number,
  ts: number,
  post: string | null,
  kind: MembershipKind = 'DELIVERY',
  order = '1',
): PointerObservation {
  return { order_id: order, kind, post_id: post, ts_us: ts, seq, source };
}

function seed(
  post: string,
  overrides: Partial<ExistingMembership> = {},
): ExistingMembership {
  return {
    id: '900',
    order_id: '1',
    kind: 'DELIVERY',
    post_id: post,
    joined_at_us: CUTOFF,
    // Migratsiya seed'i: `joined_at` va `created_at` — ayni `now()`.
    created_at_us: CUTOFF,
    source: 'seed_current',
    ...overrides,
  };
}

/** Rejani mavjud tarixga qo'llaydi (runner yozgandek): turish + seed tuzatish. */
function applyPlan(
  existing: readonly ExistingMembership[],
  plan: BackfillPlan,
): ExistingMembership[] {
  const fixes = new Map(plan.joinedAtFixes.map((f) => [f.id, f.joined_at_us]));
  return [
    ...existing.map((row) => ({
      ...row,
      joined_at_us: fixes.get(row.id) ?? row.joined_at_us,
    })),
    ...plan.stays.map((stay, index) => ({
      id: String(1000 + existing.length + index),
      order_id: stay.order_id,
      kind: stay.kind,
      post_id: stay.post_id,
      joined_at_us: stay.joined_at_us,
      created_at_us: CUTOFF + 1,
      source: stay.source,
    })),
  ];
}

describe('normalizeObservedPostId', () => {
  it.each([
    [null, null],
    ['12', '12'],
    [12, '12'],
    [' 7 ', '7'],
  ])('%p → %p', (raw, expected) => {
    expect(normalizeObservedPostId(raw)).toBe(expected);
  });

  it.each([[''], ['abc'], ['0'], ['-3'], [{}], [undefined], [true], ['1.5']])(
    '%p — yaroqsiz (undefined, kuzatuv tashlanadi)',
    (raw) => {
      expect(normalizeObservedPostId(raw)).toBeUndefined();
    },
  );
});

describe('toRuns', () => {
  it('ketma-ket takrorlar bitta yugurishga yig`iladi (null ham yugurish)', () => {
    expect(
      toRuns([
        obs('outbox', 1, 100, 'A'),
        obs('outbox', 2, 150, 'A'),
        obs('outbox', 3, 200, 'B'),
        obs('outbox', 4, 300, null),
        obs('outbox', 5, 350, null),
      ]),
    ).toEqual([
      { post_id: 'A', start_us: 100, source: 'outbox' },
      { post_id: 'B', start_us: 200, source: 'outbox' },
      { post_id: null, start_us: 300, source: 'outbox' },
    ]);
  });

  it('bir tranzaksiya (ayni manba + vaqt) ichidagi oraliq surat tashlanadi', () => {
    // A → (tx: eskirgan B surati, keyin A) — commit bo'lgan holat A.
    expect(
      toRuns([
        obs('outbox', 1, 100, 'A'),
        obs('outbox', 2, 200, 'B'),
        obs('outbox', 3, 200, 'A'),
      ]),
    ).toEqual([{ post_id: 'A', start_us: 100, source: 'outbox' }]);
  });

  it('vaqt monoton qilinadi (id tartibi created_at dan ustun)', () => {
    const runs = toRuns([
      obs('outbox', 1, 200, 'A'),
      obs('outbox', 2, 150, 'B'),
    ]);
    expect(runs).toEqual([
      { post_id: 'A', start_us: 200, source: 'outbox' },
      { post_id: 'B', start_us: 200, source: 'outbox' },
    ]);
  });
});

describe('selectByPriority', () => {
  it('outbox boshlangach faqat outbox; undan oldin jurnallar vaqt bo`yicha birlashadi', () => {
    const picked = selectByPriority([
      obs('outbox', 10, 500, 'B'),
      obs('outbox', 11, 700, null),
      obs('order_activity', 3, 100, 'A'),
      obs('order_activity', 4, 600, 'Z'), // outbox boshlangandan keyin — tashlanadi
      obs('logistics_activity', 1, 50, 'X'),
      obs('logistics_activity', 2, 120, 'Y'), // siyrak jurnallar o'zaro aralashadi
    ]);
    expect(picked.map((o) => [o.source, o.post_id])).toEqual([
      ['logistics_activity', 'X'],
      ['order_activity', 'A'],
      ['logistics_activity', 'Y'],
      ['outbox', 'B'],
      ['outbox', null],
    ]);
  });

  it('jurnallarda ayni vaqt — ustunlik (order_activity oldin)', () => {
    const picked = selectByPriority([
      obs('logistics_activity', 1, 100, 'L'),
      obs('order_activity', 9, 100, 'O'),
    ]);
    expect(picked.map((o) => o.source)).toEqual([
      'order_activity',
      'logistics_activity',
    ]);
  });

  it('outbox ichida seq (qator id) tartibi, vaqt emas', () => {
    const picked = selectByPriority([
      obs('outbox', 2, 100, 'B'),
      obs('outbox', 1, 300, 'A'),
    ]);
    expect(picked.map((o) => o.seq)).toEqual([1, 2]);
  });
});

describe('planOrderKind', () => {
  it('A → B → hozirgi C: ikki yopiq turish + seed joined_at haqiqiy vaqtga', () => {
    const plan = planOrderKind({
      observations: [
        obs('outbox', 1, 100, 'A'),
        obs('outbox', 2, 200, 'B'),
        obs('outbox', 3, 300, 'C'),
      ],
      existing: [seed('C')],
      cutoffUs: CUTOFF,
    });
    expect(plan.stays).toEqual([
      {
        order_id: '1',
        kind: 'DELIVERY',
        post_id: 'A',
        joined_at_us: 100,
        left_at_us: 200,
        next_post_id: 'B',
        source: 'backfill_outbox',
      },
      {
        order_id: '1',
        kind: 'DELIVERY',
        post_id: 'B',
        joined_at_us: 200,
        left_at_us: 300,
        next_post_id: 'C',
        source: 'backfill_outbox',
      },
    ]);
    expect(plan.joinedAtFix).toEqual({
      id: '900',
      order_id: '1',
      kind: 'DELIVERY',
      post_id: 'C',
      joined_at_us: 300,
      previous_us: CUTOFF,
    });
  });

  it('eski pochta bo`shatilgan (qaytarish tasdiqi post_id=null): yopiq turish, next=null', () => {
    const plan = planOrderKind({
      observations: [obs('outbox', 1, 100, 'A'), obs('outbox', 2, 200, null)],
      existing: [],
      cutoffUs: CUTOFF,
    });
    expect(plan.stays).toEqual([
      expect.objectContaining({
        post_id: 'A',
        joined_at_us: 100,
        left_at_us: 200,
        next_post_id: null,
      }),
    ]);
    expect(plan.joinedAtFix).toBeNull();
  });

  it('chiqish yozilmagan (osilgan) oxirgi turish — left_at = chegara', () => {
    const plan = planOrderKind({
      observations: [obs('order_activity', 1, 100, 'A')],
      existing: [],
      cutoffUs: CUTOFF,
    });
    expect(plan.stays).toEqual([
      expect.objectContaining({
        post_id: 'A',
        left_at_us: CUTOFF,
        next_post_id: null,
        source: 'backfill_order_activity',
      }),
    ]);
  });

  it('oxirgi turish seed pochtasidan farqli — next_post_id = seed pochtasi', () => {
    const plan = planOrderKind({
      observations: [obs('outbox', 1, 100, 'A')],
      existing: [seed('B')],
      cutoffUs: CUTOFF,
    });
    expect(plan.stays).toEqual([
      expect.objectContaining({
        post_id: 'A',
        left_at_us: CUTOFF,
        next_post_id: 'B',
      }),
    ]);
    expect(plan.joinedAtFix).toBeNull();
  });

  it('chegaradan keyingi kuzatuvlar e`tiborsiz (u davrni trigger yozgan)', () => {
    const plan = planOrderKind({
      observations: [
        obs('outbox', 1, CUTOFF + 500, 'X'),
        obs('outbox', 2, CUTOFF + 900, 'Y'),
      ],
      existing: [seed('C')],
      cutoffUs: CUTOFF,
    });
    expect(plan).toEqual({ stays: [], joinedAtFix: null });
  });

  it('eng erta qator trigger qatori (seed yo`q) — chegara seed vaqti, next=null', () => {
    const plan = planOrderKind({
      observations: [
        obs('outbox', 1, 100, 'A'),
        obs('outbox', 2, CUTOFF + 10, 'A'),
      ],
      existing: [seed('D', { source: 'trigger', joined_at_us: CUTOFF + 2000 })],
      cutoffUs: CUTOFF,
    });
    expect(plan.stays).toEqual([
      expect.objectContaining({
        post_id: 'A',
        joined_at_us: 100,
        left_at_us: CUTOFF,
        next_post_id: null,
      }),
    ]);
  });

  it('chegaradagi seed EMAS qator bilan ayni pochta — yangi qator ham, tuzatish ham yo`q', () => {
    const plan = planOrderKind({
      observations: [obs('outbox', 1, 100, 'A')],
      existing: [seed('A', { source: 'backfill_outbox', joined_at_us: 400 })],
      cutoffUs: CUTOFF,
    });
    expect(plan).toEqual({ stays: [], joinedAtFix: null });
  });

  it('IDEMPOTENT: natija mavjud tarixga qo`shilsa, ikkinchi reja bo`sh', () => {
    const observations = [
      obs('order_activity', 1, 50, null),
      obs('outbox', 1, 100, 'A'),
      obs('outbox', 2, 200, 'B'),
      obs('outbox', 3, 300, 'C'),
    ];
    const first = planOrderKind({
      observations,
      existing: [seed('C')],
      cutoffUs: CUTOFF,
    });
    const existing: ExistingMembership[] = [
      seed('C', { joined_at_us: first.joinedAtFix!.joined_at_us }),
      ...first.stays.map((stay, index) => ({
        id: String(index + 1),
        order_id: stay.order_id,
        kind: stay.kind,
        post_id: stay.post_id,
        joined_at_us: stay.joined_at_us,
        created_at_us: CUTOFF + 1,
        source: stay.source,
      })),
    ];
    expect(planOrderKind({ observations, existing, cutoffUs: CUTOFF })).toEqual(
      { stays: [], joinedAtFix: null },
    );
  });

  it('tegilgan seed (joined_at ≠ created_at) qayta surilmaydi', () => {
    const plan = planOrderKind({
      observations: [obs('outbox', 1, 100, 'C')],
      existing: [seed('C', { joined_at_us: 500 })],
      cutoffUs: CUTOFF,
    });
    expect(plan).toEqual({ stays: [], joinedAtFix: null });
  });

  it('turishlar doim joined_at <= left_at (vaqt teskari bo`lsa ham)', () => {
    const plan = planOrderKind({
      observations: [
        obs('outbox', 1, 900, 'A'),
        obs('outbox', 2, 100, 'B'),
        obs('outbox', 3, 50, null),
      ],
      existing: [],
      cutoffUs: CUTOFF,
    });
    expect(plan.stays.length).toBe(2);
    for (const stay of plan.stays) {
      expect(stay.joined_at_us).toBeLessThanOrEqual(stay.left_at_us);
    }
  });
});

describe('planBackfill', () => {
  it('buyurtma × tur bo`yicha guruhlaydi; CANCELED alohida', () => {
    const plan = planBackfill({
      observations: [
        obs('outbox', 1, 100, 'A', 'DELIVERY', '1'),
        obs('outbox', 1, 100, null, 'CANCELED', '1'),
        obs('outbox', 2, 200, null, 'DELIVERY', '1'),
        obs('outbox', 2, 200, 'R', 'CANCELED', '1'),
        obs('outbox', 3, 300, null, 'CANCELED', '1'),
        obs('outbox', 4, 150, 'A', 'DELIVERY', '2'),
      ],
      existing: [seed('B', { id: '901', order_id: '2' })],
      cutoffUs: CUTOFF,
    });
    expect(
      plan.stays.map((s) => [s.order_id, s.kind, s.post_id, s.next_post_id]),
    ).toEqual([
      ['1', 'CANCELED', 'R', null],
      ['1', 'DELIVERY', 'A', null],
      ['2', 'DELIVERY', 'A', 'B'],
    ]);
    expect(plan.joinedAtFixes).toEqual([]);
    expect(Object.fromEntries(plan.newMembersByPost)).toEqual({ A: 2, R: 1 });
  });

  it('newMembersByPost: buyurtmada allaqachon bor pochta va takroriy turish sanalmaydi', () => {
    const plan = planBackfill({
      observations: [
        obs('outbox', 1, 100, 'A'),
        obs('outbox', 2, 200, 'B'),
        obs('outbox', 3, 300, 'A'),
        obs('outbox', 4, 400, 'C'),
      ],
      existing: [seed('C'), seed('B', { id: '902', kind: 'CANCELED' })],
      cutoffUs: CUTOFF,
    });
    expect(plan.stays.map((s) => s.post_id)).toEqual(['A', 'B', 'A']);
    expect(Object.fromEntries(plan.newMembersByPost)).toEqual({ A: 1 });
    expect(plan.joinedAtFixes).toEqual([
      expect.objectContaining({ id: '900', joined_at_us: 400 }),
    ]);
  });
});

describe('qayta yurgizish: outbox id va created_at teskari (uzun tranzaksiya)', () => {
  // T1 t=90 da boshlanadi; T2 t=100 da boshlanib ko'chiradi va commit
  // qiladi; keyin T1 ko'chiradi — T1 surati id bo'yicha kech, vaqti erta.
  const shape = (plan: BackfillPlan) =>
    plan.stays.map((s) => [
      s.post_id,
      s.joined_at_us,
      s.left_at_us,
      s.next_post_id,
    ]);

  it('ikkinchi reja bo`sh: soxta orqaga turish (22 [90,100) → 11) yo`q', () => {
    const observations = [
      obs('outbox', 1, 100, '11', 'DELIVERY', '7'),
      obs('outbox', 2, 90, '22', 'DELIVERY', '7'),
      obs('outbox', 3, 110, null, 'DELIVERY', '7'),
    ];
    const first = planBackfill({
      observations,
      existing: [],
      cutoffUs: CUTOFF,
    });
    expect(shape(first)).toEqual([
      ['11', 100, 100, '22'],
      ['22', 100, 110, null],
    ]);
    expect(first.joinedAtFixes).toEqual([]);

    const second = planBackfill({
      observations,
      existing: applyPlan([], first),
      cutoffUs: CUTOFF,
    });
    expect(second.stays).toEqual([]);
    expect(second.joinedAtFixes).toEqual([]);
  });

  it('seed varianti: seed joined_at bir marta suriladi, ikkinchi rejada tuzatish yo`q', () => {
    const observations = [
      obs('outbox', 1, 100, '11'),
      obs('outbox', 2, 90, '33'),
    ];
    const existing = [seed('33')];
    const first = planBackfill({ observations, existing, cutoffUs: CUTOFF });
    expect(shape(first)).toEqual([['11', 100, 100, '33']]);
    expect(first.joinedAtFixes).toEqual([
      expect.objectContaining({
        id: '900',
        joined_at_us: 100,
        previous_us: CUTOFF,
      }),
    ]);

    const second = planBackfill({
      observations,
      existing: applyPlan(existing, first),
      cutoffUs: CUTOFF,
    });
    expect(second.stays).toEqual([]);
    expect(second.joinedAtFixes).toEqual([]);
  });
});

describe('isPristineSeed', () => {
  it('faqat seed va joined_at = created_at', () => {
    expect(isPristineSeed(seed('A'))).toBe(true);
    expect(isPristineSeed(seed('A', { joined_at_us: 100 }))).toBe(false);
    expect(isPristineSeed(seed('A', { source: 'trigger' }))).toBe(false);
  });
});

describe('chunkStaysByKey', () => {
  const stay = (
    order: string,
    joined: number,
    kind: MembershipKind = 'DELIVERY',
  ): PlannedStay => ({
    order_id: order,
    kind,
    post_id: 'P',
    joined_at_us: joined,
    left_at_us: joined + 1,
    next_post_id: null,
    source: 'backfill_outbox',
  });
  const shape = (parts: PlannedStay[][]) =>
    parts.map((part) =>
      part.map((s) => `${s.order_id}:${s.kind[0]}@${s.joined_at_us}`),
    );

  it('bitta (buyurtma, tur) hech qachon ikki bo`lakka bo`linmaydi', () => {
    const stays = [
      stay('1', 1),
      stay('1', 2),
      stay('2', 1),
      stay('2', 2),
      stay('2', 3),
      stay('3', 1),
    ];
    expect(shape(chunkStaysByKey(stays, 3))).toEqual([
      ['1:D@1', '1:D@2'],
      ['2:D@1', '2:D@2', '2:D@3'],
      ['3:D@1'],
    ]);
  });

  it('o`lchamdan katta kalit — o`zi alohida bo`lak (1002 turish, bo`lak 1000)', () => {
    const many = Array.from({ length: 1002 }, (_, i) => stay('7', i));
    const parts = chunkStaysByKey([stay('6', 0), ...many, stay('8', 0)], 1000);
    expect(parts.map((part) => part.length)).toEqual([1, 1002, 1]);
    expect(parts[1].map((s) => s.joined_at_us)).toEqual(
      many.map((s) => s.joined_at_us),
    );
  });

  it('kichik kalitlar bo`lakka jamlanadi; tur alohida kalit; tartib saqlanadi', () => {
    const stays = [
      stay('1', 1),
      stay('1', 1, 'CANCELED'),
      stay('2', 1),
      stay('3', 1),
      stay('3', 2),
    ];
    expect(shape(chunkStaysByKey(stays, 3))).toEqual([
      ['1:D@1', '1:C@1', '2:D@1'],
      ['3:D@1', '3:D@2'],
    ]);
    expect(shape(chunkStaysByKey(stays, 1))).toEqual([
      ['1:D@1'],
      ['1:C@1'],
      ['2:D@1'],
      ['3:D@1', '3:D@2'],
    ]);
    // Kalit ketma-ket kelmasa ham bir bo'lakda (birinchi paydo bo'lgan joyda).
    expect(
      shape(chunkStaysByKey([stay('1', 1), stay('2', 1), stay('1', 2)], 1)),
    ).toEqual([['1:D@1', '1:D@2'], ['2:D@1']]);
  });

  it('bo`sh ro`yxat — bo`laksiz; noto`g`ri o`lcham — xato', () => {
    expect(chunkStaysByKey([], 10)).toEqual([]);
    expect(() => chunkStaysByKey([stay('1', 1)], 0)).toThrow();
    expect(() => chunkStaysByKey([stay('1', 1)], 1.5)).toThrow();
  });
});

describe('usToIso', () => {
  it('mikrosekund aniqligi saqlanadi', () => {
    expect(usToIso(1_700_000_000_123_456)).toBe('2023-11-14T22:13:20.123456Z');
    expect(usToIso(0)).toBe('1970-01-01T00:00:00.000000Z');
    expect(usToIso(1_700_000_000_000_007)).toBe('2023-11-14T22:13:20.000007Z');
  });

  it('butun bo`lmagan qiymat — xato', () => {
    expect(() => usToIso(1.5)).toThrow();
    expect(() => usToIso(Number.NaN)).toThrow();
  });
});

describe('parseBackfillArgs', () => {
  it('sukut — DRY-RUN', () => {
    expect(parseBackfillArgs([])).toEqual({
      apply: false,
      batchSize: 2000,
      reportLimit: 50,
    });
  });

  it('--apply yozadi; --dry-run aniq berilsa ustun', () => {
    expect(parseBackfillArgs(['--apply']).apply).toBe(true);
    expect(parseBackfillArgs(['--apply', '--dry-run']).apply).toBe(false);
  });

  it('--batch / --report-limit', () => {
    expect(
      parseBackfillArgs(['--batch=500', '--report-limit=10']),
    ).toMatchObject({ batchSize: 500, reportLimit: 10 });
    expect(() => parseBackfillArgs(['--batch=0'])).toThrow();
    expect(() => parseBackfillArgs(['--batch=abc'])).toThrow();
    expect(() => parseBackfillArgs(['--report-limit=-1'])).toThrow();
  });
});

describe('formatBackfillReport', () => {
  const report: BackfillReport = {
    apply: false,
    cutoffIso: '2026-11-02T00:00:00.000000Z',
    observations: { outbox: 10, order_activity: 3, logistics_activity: 0 },
    ordersScanned: 4,
    staysPlanned: 5,
    staysInserted: 0,
    staysBySource: { backfill_outbox: 4, backfill_order_activity: 1 },
    joinedAtFixesPlanned: 2,
    joinedAtFixesApplied: 0,
    posts: [
      {
        post_id: '9',
        status: 'received',
        order_quantity: 3,
        members: 2,
        new_members: 2,
      },
      {
        post_id: '12',
        status: null,
        order_quantity: null,
        members: 1,
        new_members: 1,
      },
      {
        post_id: '10',
        status: 'canceled_received',
        order_quantity: 0,
        members: 4,
        new_members: 4,
      },
    ],
  };

  it('rejim, manbalar, ishora va pochta jadvali (id kamayish tartibida)', () => {
    const lines = formatBackfillReport(report, 2);
    expect(lines[0]).toContain('DRY-RUN');
    expect(lines.join('\n')).toContain(
      'outbox=10, order_activity=3, logistics_activity=0',
    );
    expect(lines.join('\n')).toContain('backfill_outbox=4');
    expect(lines.join('\n')).toContain(
      '1 tasida topilgan < order_quantity (ishora, checksum emas)',
    );
    const table = lines.slice(lines.findIndex((l) => l.startsWith('post_id')));
    expect(table.slice(1, 3)).toEqual([
      "12\t(o'chirilgan)\t-\t1\t1",
      '10\tcanceled_received\t0\t4\t4',
    ]);
    expect(table[3]).toContain('yana 1 ta pochta');
  });

  it('APPLY rejimida yozilganlar soni ko`rsatiladi', () => {
    const lines = formatBackfillReport(
      { ...report, apply: true, staysInserted: 5, joinedAtFixesApplied: 2 },
      50,
    );
    expect(lines[0]).toContain('APPLY');
    expect(lines.join('\n')).toContain('yozildi 5');
    expect(lines.join('\n')).toContain('yozildi 2');
  });
});
