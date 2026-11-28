import { Order_status, SettlementStatus } from '@app/common';
import {
  effectiveRollbackRole,
  evaluateRollbackEligibility,
  type RollbackEligibilityContext,
} from './rollback-eligibility';

/**
 * (2026-11-19, D1–D4) `evaluateRollbackEligibility` — sof qaror jadvali.
 * Haqiqiy pul oqimi PG spec'da (`order-service.rollback-rules.D1D4.pg.spec.ts`).
 */
const BRANCH = '15';
const base = (
  over: Partial<RollbackEligibilityContext> = {},
): RollbackEligibilityContext => ({
  actor: {
    id: '208',
    roles: ['manager'],
    branch_id: BRANCH,
    can_sell_cancel: true,
  },
  order: {
    status: Order_status.SOLD,
    sold_at: '2026-11-19T10:00:00Z',
    holder_type: 'COURIER',
    holder_courier_id: '301',
    holder_branch_id: BRANCH,
    branch_id: BRANCH,
    courier_id: '301',
    canceled_post_id: null,
  },
  postCourierId: '301',
  sale: {
    status: SettlementStatus.PENDING,
    courier_id: '301',
    branch_id: BRANCH,
    courier_amount: 220000,
    market_paid_by_branch_at: null,
    market_paid_by_branch_amount: 0,
  },
  holderCourierBranchId: BRANCH,
  saleCourierBranchId: BRANCH,
  hqBranchId: '1',
  carryTablePresent: true,
  ledgerMismatch: null,
  ...over,
});
const SA = {
  id: '1',
  roles: ['superadmin'],
  branch_id: null,
  can_sell_cancel: null,
};
const COURIER = {
  id: '301',
  roles: ['courier'],
  branch_id: BRANCH,
  can_sell_cancel: null,
};
const withSale = (
  sale: Partial<NonNullable<RollbackEligibilityContext['sale']>>,
) => ({ ...base().sale, ...sale }) as RollbackEligibilityContext['sale'];
const withOrder = (order: Partial<RollbackEligibilityContext['order']>) => ({
  ...base().order,
  ...order,
});

describe('evaluateRollbackEligibility (D1–D4)', () => {
  it('menejer, pul kuryerda — ruxsat (plain)', () => {
    expect(evaluateRollbackEligibility(base())).toEqual({
      allowed: true,
      code: null,
      message: null,
      httpStatus: null,
      path: 'plain',
    });
  });

  it('D3: menejerda can_sell_cancel yo`q — 403 NO_PERMISSION', () => {
    expect(
      evaluateRollbackEligibility(
        base({ actor: { ...base().actor, can_sell_cancel: false } }),
      ),
    ).toMatchObject({ allowed: false, code: 'NO_PERMISSION', httpStatus: 403 });
  });

  it('D1: COURIER_SETTLED — menejer courier_remitted, kuryer COURIER_REMITTED', () => {
    const sale = withSale({ status: SettlementStatus.COURIER_SETTLED });
    expect(evaluateRollbackEligibility(base({ sale }))).toMatchObject({
      allowed: true,
      path: 'courier_remitted',
    });
    expect(
      evaluateRollbackEligibility(base({ sale, actor: COURIER })),
    ).toMatchObject({ allowed: false, code: 'COURIER_REMITTED' });
  });

  it.each([
    ['manfiy qator', { courier_amount: -4000 }, {}, 'manfiy (kredit)'],
    ['filialsiz qator', { branch_id: null }, {}, 'filialsiz'],
    ['HQ qatori', { branch_id: '1' }, {}, 'HQ filialiga'],
    [
      'kuryer boshqa filialda',
      {},
      { saleCourierBranchId: '16' },
      'boshqa filialda',
    ],
    [
      'qoldiq jadvali yo`q',
      {},
      { carryTablePresent: false },
      'jadvali topilmadi',
    ],
    [
      'snapshot mos emas',
      {},
      { ledgerMismatch: 'mos kelmaydi' },
      'mos kelmaydi',
    ],
  ])(
    'S1: M6 sababi (%s) — menejer SUPERADMIN_ONLY, superadmin CORRECTION_REQUIRED',
    (_label, saleOver, ctxOver, text) => {
      const sale = withSale({
        status: SettlementStatus.COURIER_SETTLED,
        ...saleOver,
      });
      const manager = evaluateRollbackEligibility(base({ sale, ...ctxOver }));
      expect(manager).toMatchObject({
        allowed: false,
        code: 'SUPERADMIN_ONLY',
      });
      expect(manager.message).toContain(text);
      expect(
        evaluateRollbackEligibility(base({ sale, ...ctxOver, actor: SA })),
      ).toMatchObject({ allowed: false, code: 'CORRECTION_REQUIRED' });
    },
  );

  it.each([SettlementStatus.BRANCH_SETTLED, SettlementStatus.MARKET_SETTLED])(
    'D2: %s — menejer/kuryer SUPERADMIN_ONLY, superadmin settled',
    (status) => {
      const sale = withSale({ status });
      expect(evaluateRollbackEligibility(base({ sale }))).toMatchObject({
        code: 'SUPERADMIN_ONLY',
      });
      expect(
        evaluateRollbackEligibility(base({ sale, actor: COURIER })),
      ).toMatchObject({ code: 'SUPERADMIN_ONLY' });
      expect(
        evaluateRollbackEligibility(base({ sale, actor: SA })),
      ).toMatchObject({ allowed: true, path: 'settled' });
    },
  );

  it('D2: PR-C filial to`lagan (COURIER_SETTLED qisman) — menejer SUPERADMIN_ONLY, superadmin settled', () => {
    const sale = withSale({
      status: SettlementStatus.COURIER_SETTLED,
      market_paid_by_branch_amount: 100000,
    });
    expect(evaluateRollbackEligibility(base({ sale }))).toMatchObject({
      code: 'SUPERADMIN_ONLY',
    });
    expect(
      evaluateRollbackEligibility(base({ sale, actor: SA })),
    ).toMatchObject({ allowed: true, path: 'settled' });
  });

  it.each([
    ['cancelled (sent)', Order_status.CANCELLED_SENT, null],
    ['bekorlar pochtasida (S11)', Order_status.CANCELLED, '9100'],
    ['closed', Order_status.CLOSED, null],
    ['returned_to_market', Order_status.RETURNED_TO_MARKET, null],
  ])('D4: %s — menejer va kuryer PARCEL_NOT_IN_BRANCH', (_l, status, post) => {
    const order = withOrder({ status, canceled_post_id: post, sold_at: null });
    for (const actor of [base().actor, COURIER]) {
      expect(
        evaluateRollbackEligibility(base({ order, actor, sale: null })),
      ).toMatchObject({ allowed: false, code: 'PARCEL_NOT_IN_BRANCH' });
    }
  });

  it.each([
    ['o`z filiali kuryeri', { holder_type: 'COURIER' }, BRANCH, true],
    ['boshqa filial kuryeri', { holder_type: 'COURIER' }, '16', false],
    [
      'o`z filialida',
      { holder_type: 'BRANCH', holder_courier_id: null },
      null,
      true,
    ],
    [
      'HQ`da (S12)',
      { holder_type: 'HQ', holder_courier_id: null, holder_branch_id: null },
      null,
      false,
    ],
    [
      'marketda',
      { holder_type: 'MARKET', holder_courier_id: null },
      null,
      false,
    ],
  ])('D4 (menejer, bekor): posilka %s', (_l, over, holderBranch, allowed) => {
    const decision = evaluateRollbackEligibility(
      base({
        order: withOrder({
          status: Order_status.CANCELLED,
          sold_at: null,
          ...over,
        }),
        sale: null,
        holderCourierBranchId: holderBranch,
      }),
    );
    expect(decision.allowed).toBe(allowed);
    if (!allowed) expect(decision.code).toBe('PARCEL_NOT_IN_BRANCH');
  });

  it('S7: boshqa filial menejeri — NOT_OWN_BRANCH', () => {
    expect(
      evaluateRollbackEligibility(
        base({ actor: { ...base().actor, branch_id: '16' } }),
      ),
    ).toMatchObject({ code: 'NOT_OWN_BRANCH' });
  });

  it('kuryer: biriktirilmagan buyurtma — NOT_OWN_ORDER; PAID — SUPERADMIN_ONLY', () => {
    expect(
      evaluateRollbackEligibility(
        base({
          actor: { ...COURIER, id: '999' },
        }),
      ),
    ).toMatchObject({ code: 'NOT_OWN_ORDER' });
    expect(
      evaluateRollbackEligibility(
        base({
          actor: COURIER,
          order: withOrder({ status: Order_status.PAID }),
        }),
      ),
    ).toMatchObject({ code: 'SUPERADMIN_ONLY' });
  });

  it('sotuv qaydisiz SOLD — NO_SALE_RECORD (hamma rol)', () => {
    for (const actor of [base().actor, COURIER, SA]) {
      expect(
        evaluateRollbackEligibility(
          base({ actor, order: withOrder({ sold_at: null }) }),
        ),
      ).toMatchObject({ code: 'NO_SALE_RECORD' });
    }
  });

  it('boshqa rollar — 403 NOT_ALLOWED_ROLE; holat — STATUS_NOT_ROLLBACKABLE', () => {
    expect(
      evaluateRollbackEligibility(
        base({
          actor: {
            id: '5',
            roles: ['admin'],
            branch_id: null,
            can_sell_cancel: null,
          },
        }),
      ),
    ).toMatchObject({ code: 'NOT_ALLOWED_ROLE', httpStatus: 403 });
    expect(
      evaluateRollbackEligibility(
        base({ order: withOrder({ status: Order_status.WAITING }) }),
      ),
    ).toMatchObject({ code: 'STATUS_NOT_ROLLBACKABLE' });
  });

  it('yuklovchining 1-bosqichi (settlementLoaded=false) hisob-kitob qadamini baholamaydi', () => {
    expect(
      evaluateRollbackEligibility(
        base({
          actor: SA,
          sale: null,
          postCourierId: null,
          order: withOrder({ holder_courier_id: null, courier_id: null }),
          settlementLoaded: false,
        }),
      ),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateRollbackEligibility(
        base({
          actor: SA,
          sale: null,
          postCourierId: null,
          order: withOrder({ holder_courier_id: null, courier_id: null }),
        }),
      ),
    ).toMatchObject({ code: 'CORRECTION_REQUIRED' });
  });
  it('A-F9: ko`p rolli JWT — ustunlik superadmin > kuryer > menejer', () => {
    expect(effectiveRollbackRole({ roles: ['manager', 'superadmin'] })).toBe(
      'superadmin',
    );
    expect(effectiveRollbackRole({ roles: ['manager', 'courier'] })).toBe(
      'courier',
    );
    expect(effectiveRollbackRole({ roles: ['manager'] })).toBe('manager');
    expect(effectiveRollbackRole({ roles: ['admin'] })).toBeNull();
    // Menejer + kuryer: kuryer qoidasi (topshirilgan pul — COURIER_REMITTED).
    expect(
      evaluateRollbackEligibility(
        base({
          actor: {
            id: '301',
            roles: ['manager', 'courier'],
            branch_id: BRANCH,
            can_sell_cancel: true,
          },
          sale: withSale({ status: SettlementStatus.COURIER_SETTLED }),
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'COURIER_REMITTED' });
  });

  it('A-F8: kuryerda boshqa filialga tegishli musbat qoldiq — kredit yo`li rad (menejer SUPERADMIN_ONLY, superadmin CORRECTION_REQUIRED)', () => {
    const ctx = {
      sale: withSale({ status: SettlementStatus.COURIER_SETTLED }),
      saleCourierCarryBranchId: '99',
      saleCourierCarryAmount: 5000,
    };
    expect(evaluateRollbackEligibility(base(ctx))).toMatchObject({
      allowed: false,
      code: 'SUPERADMIN_ONLY',
      message:
        'Kuryerda boshqa filialga tegishli qoldiq bor — rollback bajarilmadi',
    });
    expect(
      evaluateRollbackEligibility(base({ ...ctx, actor: SA })),
    ).toMatchObject({ allowed: false, code: 'CORRECTION_REQUIRED' });
    // Audit 2026-11-22: boshqa filialdagi MANFIY qoldiq (T6 qarzi) ham rad —
    // aks holda kredit uni o'z filialiga «ko'chirib» qarz yo'qolardi.
    expect(
      evaluateRollbackEligibility(
        base({ ...ctx, saleCourierCarryAmount: -5000 }),
      ),
    ).toMatchObject({
      allowed: false,
      code: 'SUPERADMIN_ONLY',
      message:
        'Kuryerda boshqa filialga tegishli qoldiq bor — rollback bajarilmadi',
    });
    // O'sha filial qoldig'i (musbat yoki manfiy — qarz) yoki 0 — to'sqinlik yo'q.
    for (const carry of [
      { saleCourierCarryBranchId: BRANCH, saleCourierCarryAmount: 5000 },
      { saleCourierCarryBranchId: BRANCH, saleCourierCarryAmount: -5000 },
      { saleCourierCarryBranchId: '99', saleCourierCarryAmount: 0 },
    ]) {
      expect(
        evaluateRollbackEligibility(base({ ...ctx, ...carry })),
      ).toMatchObject({ allowed: true, path: 'courier_remitted' });
    }
  });

  it('B-3: migratsiya 246 konvertatsiya izi — superadmin CORRECTION_REQUIRED, menejer SUPERADMIN_ONLY', () => {
    expect(
      evaluateRollbackEligibility(base({ conversionTraced: true })),
    ).toMatchObject({ allowed: false, code: 'SUPERADMIN_ONLY' });
    expect(
      evaluateRollbackEligibility(base({ conversionTraced: true, actor: SA })),
    ).toMatchObject({ allowed: false, code: 'CORRECTION_REQUIRED' });
  });

  it('A-F6: kuryersiz bekor buyurtma, pul oyog`i yo`q — superadmin qaytaradi; xarajat bo`lsa — CORRECTION_REQUIRED', () => {
    const courierless = {
      actor: SA,
      sale: null,
      postCourierId: null,
      order: withOrder({
        status: Order_status.CANCELLED,
        holder_type: 'BRANCH',
        holder_courier_id: null,
        courier_id: null,
        sold_at: null,
      }),
    };
    expect(evaluateRollbackEligibility(base(courierless))).toMatchObject({
      allowed: true,
      path: 'plain',
    });
    expect(
      evaluateRollbackEligibility(
        base({
          ...courierless,
          order: { ...courierless.order, extra_cost: 10000 },
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'CORRECTION_REQUIRED' });
  });
});

/**
 * 2026-11-27 (ega): Toshkent (HQ) kuryeri sotgan, pul HQ'ga topshirilgan /
 * market to'langan buyurtmani superadmin «Kutilmoqda» ga qaytara olmasdi —
 * HQ sotuvi qatorida `branch_id` NULL, D2 settled yo'li esa faqat filial
 * qatorini bilardi (CORRECTION_REQUIRED «Kuryer to'lovi filialsiz qatorda»).
 */
describe('HQ sotuvi (branch_id NULL) — superadmin settled yo`li', () => {
  const HQ = '1';
  const HQ_COURIER = {
    id: '301',
    roles: ['courier'],
    branch_id: HQ,
    can_sell_cancel: null,
  };
  const hqBase = (
    status: SettlementStatus,
    over: Partial<RollbackEligibilityContext> = {},
  ) =>
    base({
      actor: SA,
      order: withOrder({
        status: Order_status.PAID,
        holder_branch_id: HQ,
        branch_id: HQ,
      }),
      sale: withSale({ status, branch_id: null }),
      saleCourierBranchId: HQ,
      hqBranchId: HQ,
      saleCourierCarryBranchId: null,
      saleCourierCarryAmount: 0,
      ...over,
    });

  it.each([
    [SettlementStatus.BRANCH_SETTLED, Order_status.SOLD],
    [SettlementStatus.MARKET_SETTLED, Order_status.PAID],
    [SettlementStatus.MARKET_SETTLED, Order_status.PARTLY_PAID],
  ])('⭐ %s (%s): superadmin — ruxsat (settled)', (status, orderStatus) => {
    expect(
      evaluateRollbackEligibility(
        hqBase(status, {
          order: withOrder({
            status: orderStatus,
            holder_branch_id: HQ,
            branch_id: HQ,
          }),
        }),
      ),
    ).toEqual({
      allowed: true,
      code: null,
      message: null,
      httpStatus: null,
      path: 'settled',
    });
  });

  it('kuryersiz HQ sotuvi (HQ menejeri) — superadmin ruxsat (settled)', () => {
    expect(
      evaluateRollbackEligibility(
        hqBase(SettlementStatus.MARKET_SETTLED, {
          postCourierId: null,
          order: withOrder({
            status: Order_status.PAID,
            holder_type: 'BRANCH',
            holder_courier_id: null,
            courier_id: null,
            holder_branch_id: HQ,
            branch_id: HQ,
          }),
          sale: withSale({
            status: SettlementStatus.MARKET_SETTLED,
            courier_id: null,
            branch_id: null,
            courier_amount: 0,
          }),
        }),
      ),
    ).toMatchObject({ allowed: true, path: 'settled' });
  });

  it.each([
    [
      'kuryer endi viloyat filialida',
      { saleCourierBranchId: BRANCH },
      "Kuryer endi bosh ofis (HQ) kuryeri emas — HQ'ga topshirilgan summani uning hisobiga o'tkazib bo'lmaydi, rollback bajarilmadi",
    ],
    [
      'kuryer filialga biriktirilmagan',
      { saleCourierBranchId: null },
      "Kuryer endi bosh ofis (HQ) kuryeri emas — HQ'ga topshirilgan summani uning hisobiga o'tkazib bo'lmaydi, rollback bajarilmadi",
    ],
    [
      'kuryerda filialga bog`langan qoldiq',
      { saleCourierCarryBranchId: BRANCH, saleCourierCarryAmount: 5000 },
      'Kuryerda boshqa filialga tegishli qoldiq bor — rollback bajarilmadi',
    ],
    [
      'qoldiq jadvali yo`q',
      { carryTablePresent: false },
      "Hisob-kitob qoldig'i jadvali topilmadi — kuryer kreditini yozib bo'lmaydi, rollback bajarilmadi",
    ],
    ['daftar mos emas', { ledgerMismatch: 'mos kelmaydi' }, 'mos kelmaydi'],
  ])(
    'HQ qatori, %s — superadmin CORRECTION_REQUIRED',
    (_label, over, message) => {
      expect(
        evaluateRollbackEligibility(
          hqBase(SettlementStatus.MARKET_SETTLED, over),
        ),
      ).toMatchObject({ allowed: false, code: 'CORRECTION_REQUIRED', message });
    },
  );

  it('HQ qatori, HQ qoldig`i (branch_id NULL, musbat yoki manfiy) — to`sqinlik emas', () => {
    for (const amount of [5000, -5000]) {
      expect(
        evaluateRollbackEligibility(
          hqBase(SettlementStatus.MARKET_SETTLED, {
            saleCourierCarryBranchId: null,
            saleCourierCarryAmount: amount,
          }),
        ),
      ).toMatchObject({ allowed: true, path: 'settled' });
    }
  });

  it('HQ qatorida manfiy (kredit) summa yoki filial to`lovi — CORRECTION_REQUIRED', () => {
    expect(
      evaluateRollbackEligibility(
        hqBase(SettlementStatus.BRANCH_SETTLED, {
          sale: withSale({
            status: SettlementStatus.BRANCH_SETTLED,
            branch_id: null,
            courier_amount: -4000,
          }),
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'CORRECTION_REQUIRED' });
    expect(
      evaluateRollbackEligibility(
        hqBase(SettlementStatus.BRANCH_SETTLED, {
          sale: withSale({
            status: SettlementStatus.BRANCH_SETTLED,
            branch_id: null,
            market_paid_by_branch_amount: 1000,
          }),
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'CORRECTION_REQUIRED' });
  });

  it('HQ kuryeri / HQ menejeri o`zi — SUPERADMIN_ONLY, xabarda market yo`q', () => {
    const courier = evaluateRollbackEligibility(
      hqBase(SettlementStatus.MARKET_SETTLED, { actor: HQ_COURIER }),
    );
    expect(courier).toMatchObject({ allowed: false, code: 'SUPERADMIN_ONLY' });
    expect(courier.message).not.toMatch(/market/i);
  });
});

/**
 * Ega (2026-11-27): HQ marketga to'laganmi-yo'qmi — kuryer va menejerga
 * ko'rinmaydi; rad xabari ham buni aytmaydi.
 */
describe('kuryer / menejer rad xabarida market to`lovi tilga olinmaydi', () => {
  it.each([
    ['menejer', base().actor],
    ['kuryer', COURIER],
  ])('%s: PAID va PARTLY_PAID — bir xil neytral xabar', (_label, actor) => {
    for (const status of [Order_status.PAID, Order_status.PARTLY_PAID]) {
      const res = evaluateRollbackEligibility(
        base({ actor, order: withOrder({ status }) }),
      );
      expect(res).toMatchObject({
        allowed: false,
        code: 'SUPERADMIN_ONLY',
        message:
          'Bu buyurtmani faqat superadmin qaytara oladi — superadminga murojaat qiling',
      });
    }
  });

  it('kuryer: filial marketga to`lagan qator va 246 izi — neytral xabar; menejer o`z amalini ko`radi', () => {
    const paidByBranch = withSale({
      status: SettlementStatus.COURIER_SETTLED,
      market_paid_by_branch_amount: 100000,
    });
    const courier = evaluateRollbackEligibility(
      base({ actor: COURIER, sale: paidByBranch }),
    );
    expect(courier).toMatchObject({ code: 'SUPERADMIN_ONLY' });
    expect(courier.message).not.toMatch(/market/i);
    expect(
      evaluateRollbackEligibility(base({ sale: paidByBranch })).message,
    ).toContain('filial kassasidan');

    const traced = evaluateRollbackEligibility(
      base({ actor: COURIER, conversionTraced: true }),
    );
    expect(traced).toMatchObject({ code: 'SUPERADMIN_ONLY' });
    expect(traced.message).not.toMatch(/market/i);
  });
});
