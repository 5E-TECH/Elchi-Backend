import { of, throwError } from 'rxjs';
import { Status } from '@app/common';
import { makeTermRepo } from './testing/term-repo.mock';
import { InvestorServiceService } from './investor-service.service';

/**
 * Ega 2026-11-28: «investorlik sanasi»ni 1-noyabr qilib qo'ydim, lekin hech
 * qanday foyda ko'rinmadi — investor haqqi belgilangan sanadan boshlab
 * hisoblansin; sof foydadanmi yoki daromaddanmi — tanlansin (BeePost kabi).
 */

const INVESTOR = {
  id: '7',
  user_id: '25',
  name: 'Ali Investor',
  phone_number: '+998901112233',
  status: Status.ACTIVE,
  description: null,
  share_percent: 10,
  profit_basis: 'net',
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  isDeleted: false,
};

const PNL = {
  to_day: '2026-11-28',
  items: [
    { period: '2026-10-31', gross: 9000, opex: 0, net: 9000, other_income: 0 },
    { period: '2026-11-01', gross: 1000, opex: 400, net: 600, other_income: 0 },
    {
      period: '2026-11-20',
      gross: 2000,
      opex: 2500,
      net: -500,
      other_income: 0,
    },
    {
      period: '2026-11-27',
      gross: 3000,
      opex: 1000,
      net: 2000,
      other_income: 5e6,
    },
  ],
};

function qb(raw: Record<string, unknown>) {
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(raw),
  };
  return builder;
}

function makeService(
  opts: {
    terms?: any[];
    paid?: string;
    financeError?: boolean;
    pnl?: typeof PNL;
    investor?: Record<string, unknown>;
  } = {},
) {
  const investor = { ...INVESTOR, ...(opts.investor ?? {}) };
  const investorRepo: any = {
    find: jest.fn().mockResolvedValue([investor]),
    findOne: jest.fn().mockResolvedValue(investor),
    create: jest.fn((dto: any) => dto),
    save: jest.fn((row: any) =>
      Promise.resolve({ id: row.id ?? '99', ...row }),
    ),
  };
  const investmentRepo: any = {
    createQueryBuilder: jest.fn(() =>
      qb({ total: '0', count: '0', first_at: null, last_at: null }),
    ),
  };
  const profitShareRepo: any = {
    createQueryBuilder: jest.fn(() =>
      qb({
        paid: opts.paid ?? '0',
        unpaid: '0',
        count: '0',
        last_paid_at: null,
      }),
    ),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const financeClient: any = {
    send: jest.fn(() =>
      opts.financeError
        ? throwError(() => ({ statusCode: 500, message: 'down' }))
        : of({ data: opts.pnl ?? PNL }),
    ),
  };
  const termRepo = makeTermRepo(opts.terms ?? [], investorRepo);
  const service = new InvestorServiceService(
    investorRepo,
    investmentRepo,
    profitShareRepo,
    activityLog,
    financeClient,
    termRepo,
  );
  return {
    service,
    investor,
    investorRepo,
    financeClient,
    termRepo,
    activityLog,
  };
}

const statusOf = (err: unknown): number | undefined =>
  (err as any)?.getError?.()?.statusCode;

const TERM_NOV1 = {
  investor_id: '7',
  share_percent: 10,
  profit_basis: 'net',
  effective_from: '2026-11-01',
};

describe('investor ulushi — belgilangan sanadan boshlab (dashboard)', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: new Date('2026-11-28T07:00:00.000Z'),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout'],
    });
  });
  afterAll(() => jest.useRealTimers());

  it('⭐ 1-noyabrdan 10% sof foydadan: ulush hisoblanadi, oldingi kun kirmaydi', async () => {
    const { service, financeClient } = makeService({ terms: [TERM_NOV1] });
    const res: any = await service.getInvestorDashboard('7', 2);

    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.pnl.series' },
      expect.objectContaining({ from_day: '2026-11-01', granularity: 'day' }),
    );
    // 60 − 50 + 200 = 210 (31-oktabr — shartdan oldin, kirmaydi).
    expect(res.data.summary).toMatchObject({
      accrued_profit: 210,
      accrued_basis: 2100,
      total_profit: 210,
      total_paid_profit: 0,
      total_unpaid_profit: 210,
      share_started_at: '2026-11-01',
      accrued_through: '2026-11-28',
      profit_basis: 'net',
    });
    expect(res.data.monthly.items).toEqual([
      expect.objectContaining({ month: '2026-10', accrued_amount: 0 }),
      expect.objectContaining({
        month: '2026-11',
        accrued_amount: 210,
        basis_amount: 2100,
        paid_amount: 0,
        unpaid_amount: 210,
        share_percent: 10,
        profit_basis: 'net',
      }),
    ]);
    expect(res.data.share_terms).toEqual([
      {
        share_percent: 10,
        profit_basis: 'net',
        effective_from: '2026-11-01',
        effective_to: null,
      },
    ]);
  });

  it('⭐ daromaddan (gross): xarajat ayrilmaydi, qo`lda kirim kirmaydi', async () => {
    const { service } = makeService({
      terms: [{ ...TERM_NOV1, profit_basis: 'gross' }],
      investor: { profit_basis: 'gross' },
    });
    const res: any = await service.getInvestorDashboard('7', 1);
    // (1000 + 2000 + 3000) × 10%.
    expect(res.data.summary.accrued_profit).toBe(600);
    expect(res.data.summary.profit_basis).toBe('gross');
  });

  it('to`langan pul «kutilayotgan» dan ayriladi', async () => {
    const { service } = makeService({ terms: [TERM_NOV1], paid: '150' });
    const res: any = await service.getInvestorDashboard('7', 1);
    expect(res.data.summary).toMatchObject({
      accrued_profit: 210,
      total_paid_profit: 150,
      total_unpaid_profit: 60,
    });
    expect(res.data.monthly.items[0]).toMatchObject({
      paid_amount: 150,
      unpaid_amount: 60,
    });
  });

  it('⭐ zarar ham bo`lishiladi: zarar foydadan ko`p — ulush manfiy, keyingi foyda avval uni qoplaydi', async () => {
    const lossy = {
      to_day: '2026-11-28',
      items: [
        { period: '2026-11-01', gross: 1000, opex: 0, net: 1000, other_income: 0 },
        // Ish haqi kuni: sof foyda −3000.
        { period: '2026-11-05', gross: 500, opex: 3500, net: -3000, other_income: 0 },
      ],
    };
    const loss = makeService({ terms: [TERM_NOV1], pnl: lossy });
    const res: any = await loss.service.getInvestorDashboard('7', 1);
    // (1000 − 3000) × 10% = −200: investor zarar ulushini ko'taradi.
    expect(res.data.summary).toMatchObject({
      accrued_profit: -200,
      accrued_basis: -2000,
      total_unpaid_profit: -200,
    });
    expect(res.data.monthly.items[0]).toMatchObject({
      accrued_amount: -200,
      paid_amount: 0,
      unpaid_amount: -200,
    });

    // Keyingi kun +5000: avval 200 zarar qoplanadi, qolgani — 300.
    const recovered = makeService({
      terms: [TERM_NOV1],
      pnl: {
        ...lossy,
        items: [
          ...lossy.items,
          { period: '2026-11-20', gross: 6000, opex: 1000, net: 5000, other_income: 0 },
        ],
      },
    });
    const after: any = await recovered.service.getInvestorDashboard('7', 1);
    expect(after.data.summary.accrued_profit).toBe(300);
  });

  it('shart yo`q — moliyaga so`rov ketmaydi, nollar', async () => {
    const { service, financeClient } = makeService({
      investor: { share_percent: null },
    });
    const res: any = await service.getInvestorDashboard('7', 1);
    expect(financeClient.send).not.toHaveBeenCalled();
    expect(res.data.summary).toMatchObject({
      accrued_profit: 0,
      share_started_at: null,
      accrued_through: null,
    });
  });

  it('moliya javob bermasa — 503 (nol ko`rsatilmaydi)', async () => {
    const { service } = makeService({ terms: [TERM_NOV1], financeError: true });
    const err = await service.getInvestorDashboard('7', 1).catch((e) => e);
    expect(statusOf(err)).toBe(503);
  });
});

describe('ulush shartini o`zgartirish (PUT /investors/:id/share-terms)', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: new Date('2026-11-28T07:00:00.000Z'),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout'],
    });
  });
  afterAll(() => jest.useRealTimers());

  it('⭐ 1-dekabrdan 15% daromaddan: eski shart yopiladi, investor nusxasi yangilanadi', async () => {
    const { service, termRepo, investorRepo, activityLog } = makeService({
      terms: [TERM_NOV1],
    });
    const res: any = await service.setShareTerms(
      '7',
      {
        share_percent: 15,
        profit_basis: 'gross',
        effective_from: '2026-11-25',
      },
      { id: '1', roles: ['superadmin'] },
    );

    expect(
      termRepo.rows.map((r: any) => [
        r.effective_from,
        r.effective_to,
        r.share_percent,
        r.profit_basis,
      ]),
    ).toEqual([
      ['2026-11-01', '2026-11-25', 10, 'net'],
      ['2026-11-25', null, 15, 'gross'],
    ]);
    expect(investorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '7',
        share_percent: 15,
        profit_basis: 'gross',
      }),
    );
    expect(res.data.share_terms).toHaveLength(2);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { kind: 'share_terms' },
        user_id: '1',
      }),
    );
  });

  it('⭐ asosni joriy shart boshidan tuzatish — yangi versiya ochilmaydi', async () => {
    const { service, termRepo } = makeService({ terms: [TERM_NOV1] });
    await service.setShareTerms(
      '7',
      {
        share_percent: 10,
        profit_basis: 'gross',
        effective_from: '2026-11-01',
      },
      { id: '1', roles: ['superadmin'] },
    );
    expect(termRepo.rows).toHaveLength(1);
    expect(termRepo.rows[0]).toMatchObject({
      effective_from: '2026-11-01',
      effective_to: null,
      profit_basis: 'gross',
    });
  });

  it.each([
    [{ share_percent: 10, effective_from: '2026-12-01' }, 'kelajak sanasi'],
    [{ share_percent: 101 }, 'ulush 100 dan katta'],
    [{ profit_basis: 'net' }, 'ulush yo`q'],
    [{ share_percent: 10, profit_basis: 'revenue' }, 'noma`lum asos'],
    [{ share_percent: 10, effective_from: '01.11.2026' }, 'sana formati'],
  ])('%p → 400 (%s), hech narsa yozilmaydi', async (dto) => {
    const { service, termRepo } = makeService({ terms: [TERM_NOV1] });
    const err = await service
      .setShareTerms('7', dto, { id: '1', roles: ['superadmin'] })
      .catch((e) => e);
    expect(statusOf(err)).toBe(400);
    expect(termRepo.update).not.toHaveBeenCalled();
    expect(termRepo.save).not.toHaveBeenCalled();
  });

  it('PATCH share_started_at — «investorlik sanasi» tuzatiladi', async () => {
    const { service, termRepo } = makeService({ terms: [TERM_NOV1] });
    await service.updateInvestor(
      '7',
      { share_started_at: '2026-11-10' },
      { id: '1', roles: ['superadmin'] },
    );
    expect(termRepo.rows[0].effective_from).toBe('2026-11-10');
  });

  it('PATCH share_percent: null — joriy shart bugun yopiladi', async () => {
    const { service, termRepo } = makeService({ terms: [TERM_NOV1] });
    await service.updateInvestor(
      '7',
      { share_percent: null },
      {
        id: '1',
        roles: ['superadmin'],
      },
    );
    expect(termRepo.rows[0].effective_to).toBe('2026-11-28');
  });
});

describe('investor yaratish — birinchi shart «investorlik sanasi»dan', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: new Date('2026-11-28T07:00:00.000Z'),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout'],
    });
  });
  afterAll(() => jest.useRealTimers());

  it('⭐ share_started_at + profit_basis bilan', async () => {
    const { service, termRepo, investorRepo } = makeService();
    investorRepo.findOne.mockResolvedValue(null);
    await service.createInvestor(
      {
        name: 'Vali',
        phone_number: '+998901234567',
        share_percent: 12.5,
        profit_basis: 'gross',
        share_started_at: '2026-11-01',
      } as any,
      { id: '1', roles: ['superadmin'] },
    );
    expect(investorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ share_percent: 12.5, profit_basis: 'gross' }),
    );
    expect(termRepo.rows).toEqual([
      expect.objectContaining({
        investor_id: '99',
        share_percent: 12.5,
        profit_basis: 'gross',
        effective_from: '2026-11-01',
        effective_to: null,
        created_by: '1',
      }),
    ]);
  });

  it('sanasiz — bugundan; ulushsiz — shart yo`q', async () => {
    const withShare = makeService();
    withShare.investorRepo.findOne.mockResolvedValue(null);
    await withShare.service.createInvestor({
      name: 'Vali',
      phone_number: '+998901234567',
      share_percent: 5,
    });
    expect(withShare.termRepo.rows[0]).toMatchObject({
      effective_from: '2026-11-28',
      profit_basis: 'net',
    });

    const noShare = makeService();
    noShare.investorRepo.findOne.mockResolvedValue(null);
    await noShare.service.createInvestor({
      name: 'Vali',
      phone_number: '+998901234567',
    });
    expect(noShare.termRepo.rows).toHaveLength(0);
  });
});
