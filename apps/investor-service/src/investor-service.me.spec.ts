import { of } from 'rxjs';
import { Status } from '@app/common';
import { InvestorServiceService } from './investor-service.service';
import { InvestorServiceController } from './investor-service.controller';

/**
 * vpKijXce — investorning o'zi uchun ("me") o'qish.
 *
 * Asosiy talablar:
 *  - doira FAQAT requester (JWT sub → investors.user_id) dan;
 *  - payload'dagi investor_id hech qachon o'qilmaydi (TC3/TC4);
 *  - har qanday noaniqlik → ma'lumot yo'q (fail-closed, TC9);
 *  - javobda maxfiy maydonlar (user_id, description, isDeleted, updatedAt)
 *    yo'q.
 */

const ME = {
  id: '7',
  user_id: '25',
  name: 'Ali Investor',
  phone_number: '+998901112233',
  status: Status.ACTIVE,
  description: 'ICHKI: shartnoma 3-ilova, 5% chegirma',
  createdAt: new Date('2026-01-10T00:00:00.000Z'),
  updatedAt: new Date('2026-02-10T00:00:00.000Z'),
  isDeleted: false,
};

function makeQb(raw: Record<string, unknown>) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(raw),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  return qb;
}

function makeService(
  opts: {
    linked?: any[];
    investmentAgg?: Record<string, unknown>;
    profitAgg?: Record<string, unknown>;
    latestProfit?: any;
    investments?: any[];
    profits?: any[];
    monthlyRows?: any[];
    investorById?: any;
  } = {},
) {
  const investorRepo: any = {
    find: jest.fn().mockResolvedValue(opts.linked ?? [ME]),
    findOne: jest.fn().mockResolvedValue(opts.investorById ?? null),
    create: jest.fn((dto: any) => dto),
    save: jest.fn((row: any) =>
      Promise.resolve({ id: row.id ?? '99', ...row }),
    ),
  };
  const investmentQbs: any[] = [];
  const investmentRepo: any = {
    createQueryBuilder: jest.fn(() => {
      const qb = makeQb(
        opts.investmentAgg ?? {
          total: '0',
          count: '0',
          first_at: null,
          last_at: null,
        },
      );
      investmentQbs.push(qb);
      return qb;
    }),
    findAndCount: jest
      .fn()
      .mockResolvedValue([
        opts.investments ?? [],
        (opts.investments ?? []).length,
      ]),
  };
  const profitQbs: any[] = [];
  const profitShareRepo: any = {
    createQueryBuilder: jest.fn(() => {
      const qb = makeQb(
        opts.profitAgg ?? {
          paid: '0',
          unpaid: '0',
          count: '0',
          last_paid_at: null,
          total: '0',
        },
      );
      profitQbs.push(qb);
      return qb;
    }),
    findOne: jest.fn().mockResolvedValue(opts.latestProfit ?? null),
    find: jest.fn().mockResolvedValue(opts.monthlyRows ?? []),
    findAndCount: jest
      .fn()
      .mockResolvedValue([opts.profits ?? [], (opts.profits ?? []).length]),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const financeClient: any = { send: jest.fn(() => of({ data: {} })) };
  const service = new InvestorServiceService(
    investorRepo,
    investmentRepo,
    profitShareRepo,
    activityLog,
    financeClient,
  );
  return {
    service,
    investorRepo,
    investmentRepo,
    profitShareRepo,
    investmentQbs,
    profitQbs,
    activityLog,
  };
}

const INVESTOR_REQ = { id: '25', roles: ['investor'] };

function statusOf(err: unknown): number | undefined {
  return (err as any)?.getError?.()?.statusCode;
}

async function expectStatus(promise: Promise<unknown>, code: number) {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(statusOf(caught)).toBe(code);
}

describe('vpKijXce — investor "me": doira va fail-closed', () => {
  it('⭐ investor JWT sub (user_id) bo`yicha topiladi, payload ID emas', async () => {
    const { service, investorRepo } = makeService();
    const res: any = await service.getMyProfile(INVESTOR_REQ);

    expect(investorRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { user_id: '25', isDeleted: false },
      }),
    );
    expect(res.data.investor.id).toBe('7');
  });

  it.each([
    ['requester yo`q', undefined, 403],
    ['rol yo`q', { id: '25', roles: [] }, 403],
    ['boshqa rol (admin)', { id: '25', roles: ['admin'] }, 403],
    ['sub yo`q', { roles: ['investor'] }, 403],
    [
      "sub '0' (bog'lanmaganlar bilan to'qnashmasin)",
      { id: '0', roles: ['investor'] },
      403,
    ],
    ['sub raqam emas', { id: '25 OR 1=1', roles: ['investor'] }, 403],
  ])('⭐ %s → %s, bazaga so`rov ham yo`q', async (_label, requester, code) => {
    const { service, investorRepo } = makeService();
    await expectStatus(service.getMyProfile(requester as any), code);
    expect(investorRepo.find).not.toHaveBeenCalled();
  });

  it('bog`lanmagan login → 404 (ma`lumot yo`q)', async () => {
    const { service, investmentRepo } = makeService({ linked: [] });
    await expectStatus(service.getMyProfile(INVESTOR_REQ), 404);
    expect(investmentRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('⭐ bitta loginga 2 ta investor → 409 (taxmin qilinmaydi)', async () => {
    const { service, investmentRepo } = makeService({
      linked: [ME, { ...ME, id: '8' }],
    });
    await expectStatus(service.getMyProfile(INVESTOR_REQ), 409);
    expect(investmentRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('nofaol investor → 403', async () => {
    const { service } = makeService({
      linked: [{ ...ME, status: Status.INACTIVE }],
    });
    await expectStatus(service.getMyProfile(INVESTOR_REQ), 403);
  });

  it('rol katta harf bilan kelsa ham (Investor) qabul qilinadi', async () => {
    const { service } = makeService();
    const res: any = await service.getMyProfile({
      id: '25',
      roles: [' Investor '],
    });
    expect(res.data.investor.id).toBe('7');
  });
});

describe('vpKijXce — GET /investors/me: profil + kartalar', () => {
  it('⭐ maxfiy maydonlar (user_id, description, isDeleted, updatedAt) yo`q', async () => {
    const { service } = makeService();
    const res: any = await service.getMyProfile(INVESTOR_REQ);

    expect(Object.keys(res.data.investor).sort()).toEqual(
      ['created_at', 'id', 'name', 'phone_number', 'status'].sort(),
    );
    const json = JSON.stringify(res.data);
    expect(json).not.toContain('ICHKI');
    expect(json).not.toContain('user_id');
  });

  it('⭐ kartalar: investitsiya, foiz, to`langan va kutilayotgan foyda', async () => {
    const { service, investmentQbs, profitQbs, profitShareRepo } = makeService({
      investmentAgg: {
        total: '150000000.50',
        count: '3',
        first_at: '2026-01-15T00:00:00.000Z',
        last_at: new Date('2026-06-01T00:00:00.000Z'),
      },
      profitAgg: {
        paid: '4500000.10',
        unpaid: '1500000.20',
        count: '4',
        last_paid_at: '2026-09-05T10:00:00.000Z',
      },
      latestProfit: { percentage: 3.5 },
    });
    const res: any = await service.getMyProfile(INVESTOR_REQ);

    expect(res.data.summary).toEqual({
      total_invested: 150000000.5,
      investments_count: 3,
      first_invested_at: new Date('2026-01-15T00:00:00.000Z'),
      last_invested_at: new Date('2026-06-01T00:00:00.000Z'),
      total_paid_profit: 4500000.1,
      total_unpaid_profit: 1500000.2,
      total_profit: 6000000.3,
      profit_shares_count: 4,
      current_percentage: 3.5,
      last_paid_at: new Date('2026-09-05T10:00:00.000Z'),
    });

    // Yig'indilar FAQAT shu investor bo'yicha va soft-delete'siz.
    for (const qb of [...investmentQbs, ...profitQbs]) {
      expect(qb.where).toHaveBeenCalledWith(expect.any(String), {
        investorId: '7',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
        isDeleted: false,
      });
    }
    expect(profitShareRepo.findOne).toHaveBeenCalledWith({
      where: { investor_id: '7', isDeleted: false },
      order: { period_end: 'DESC', createdAt: 'DESC' },
    });
  });

  it('yozuvsiz investor: nollar va null — NaN emas', async () => {
    const { service } = makeService({
      investmentAgg: {
        total: null,
        count: null,
        first_at: null,
        last_at: null,
      },
      profitAgg: { paid: null, unpaid: null, count: null, last_paid_at: null },
    });
    const res: any = await service.getMyProfile(INVESTOR_REQ);
    expect(res.data.summary).toEqual({
      total_invested: 0,
      investments_count: 0,
      first_invested_at: null,
      last_invested_at: null,
      total_paid_profit: 0,
      total_unpaid_profit: 0,
      total_profit: 0,
      profit_shares_count: 0,
      current_percentage: null,
      last_paid_at: null,
    });
  });
});

describe('vpKijXce — /investors/me/investments va /me/profits', () => {
  it('⭐ TC4: query`dagi boshqa investor_id e`tiborsiz — o`z ID si', async () => {
    const { service, investmentRepo } = makeService({
      investments: [
        {
          id: '11',
          investor_id: '7',
          branch_id: '3',
          amount: 1000,
          invested_at: new Date('2026-03-01T00:00:00.000Z'),
          description: 'ICHKI izoh',
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          updatedAt: new Date(),
          isDeleted: false,
        },
      ],
    });
    const res: any = await service.getMyInvestments(INVESTOR_REQ, {
      investor_id: '26',
      page: 2,
      limit: 5,
    } as any);

    const where = investmentRepo.findAndCount.mock.calls[0][0].where;
    expect(where.investor_id).toBe('7');
    expect(res.data.items).toEqual([
      {
        id: '11',
        amount: 1000,
        invested_at: new Date('2026-03-01T00:00:00.000Z'),
        branch_id: '3',
        created_at: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);
    expect(res.data.meta).toEqual(
      expect.objectContaining({ page: 2, limit: 5 }),
    );
  });

  it('⭐ foyda tarixi: faqat o`ziniki, is_paid filtri, maxfiy maydonsiz', async () => {
    const { service, profitShareRepo } = makeService({
      profits: [
        {
          id: '21',
          investor_id: '7',
          amount: 350,
          percentage: 3.5,
          period_start: new Date('2026-08-01T00:00:00.000Z'),
          period_end: new Date('2026-08-31T00:00:00.000Z'),
          is_paid: true,
          paid_at: new Date('2026-09-05T00:00:00.000Z'),
          description: 'ICHKI',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          updatedAt: new Date(),
          isDeleted: false,
        },
      ],
    });
    const res: any = await service.getMyProfits(INVESTOR_REQ, {
      investor_id: '26',
      is_paid: true,
    } as any);

    const where = profitShareRepo.findAndCount.mock.calls[0][0].where;
    expect(where).toEqual({
      isDeleted: false,
      investor_id: '7',
      is_paid: true,
    });
    expect(Object.keys(res.data.items[0]).sort()).toEqual(
      [
        'amount',
        'created_at',
        'id',
        'is_paid',
        'paid_at',
        'percentage',
        'period_end',
        'period_start',
      ].sort(),
    );
  });

  it('bog`lanmagan investor ro`yxat so`rasa — ro`yxat so`rovi umuman yo`q', async () => {
    const { service, investmentRepo, profitShareRepo } = makeService({
      linked: [],
    });
    await expectStatus(service.getMyInvestments(INVESTOR_REQ), 404);
    await expectStatus(service.getMyProfits(INVESTOR_REQ), 404);
    expect(investmentRepo.findAndCount).not.toHaveBeenCalled();
    expect(profitShareRepo.findAndCount).not.toHaveBeenCalled();
  });
});

describe('vpKijXce — oylik foyda grafigi (Toshkent oyi)', () => {
  // 2026-10-14 12:00 Toshkent.
  const NOW = new Date('2026-10-14T07:00:00.000Z');

  it('⭐ oylar Toshkent bo`yicha, bo`sh oylar 0, tiyinlarda aniq yig`indi', async () => {
    const { service, profitShareRepo } = makeService({
      monthlyRows: [
        // 30-sentabr 23:30 Toshkent → sentabr.
        {
          amount: 0.1,
          is_paid: true,
          period_end: new Date('2026-09-30T18:30:00.000Z'),
        },
        {
          amount: 0.2,
          is_paid: true,
          period_end: new Date('2026-09-15T00:00:00.000Z'),
        },
        // UTC'da 30-sentabr, Toshkentda 1-oktabr 00:30 → oktabr.
        {
          amount: 500,
          is_paid: false,
          period_end: new Date('2026-09-30T19:30:00.000Z'),
        },
        // Kelajak davri — oynadan tashqari.
        {
          amount: 999,
          is_paid: false,
          period_end: new Date('2026-12-31T00:00:00.000Z'),
        },
      ],
    });
    const items = await service.buildMonthlyProfits('7', 3, NOW);

    expect(items).toEqual([
      { month: '2026-08', paid_amount: 0, unpaid_amount: 0, total_amount: 0 },
      {
        month: '2026-09',
        paid_amount: 0.3,
        unpaid_amount: 0,
        total_amount: 0.3,
      },
      {
        month: '2026-10',
        paid_amount: 0,
        unpaid_amount: 500,
        total_amount: 500,
      },
    ]);
    const where = profitShareRepo.find.mock.calls[0][0].where;
    expect(where.investor_id).toBe('7');
    expect(where.isDeleted).toBe(false);
    // Oyna boshi: 1-avgust 00:00 Toshkent = 31-iyul 19:00 UTC.
    expect(where.period_end.value).toEqual(
      new Date('2026-07-31T19:00:00.000Z'),
    );
  });

  it('yil chegarasidan o`tadi (yanvar → oldingi yil dekabri)', async () => {
    const { service } = makeService({ monthlyRows: [] });
    const items = await service.buildMonthlyProfits(
      '7',
      2,
      new Date('2026-01-05T00:00:00.000Z'),
    );
    expect(items.map((i) => i.month)).toEqual(['2025-12', '2026-01']);
  });

  it.each([[0], [37], [1.5], ['abc']])('months=%s → 400', async (months) => {
    const { service } = makeService();
    await expectStatus(service.getMyDashboard(INVESTOR_REQ, months), 400);
  });

  it('dashboard: default 12 oy, profil + kartalar + grafik', async () => {
    const { service } = makeService();
    const res: any = await service.getMyDashboard(INVESTOR_REQ);
    expect(res.data.monthly.months).toBe(12);
    expect(res.data.monthly.items).toHaveLength(12);
    expect(res.data.investor.id).toBe('7');
    expect(res.data.summary).toBeDefined();
  });

  it('TC7: admin nazorati — investor_id bo`yicha AYNAN shu ko`rinish', async () => {
    const { service, investorRepo } = makeService({ investorById: ME });
    const res: any = await service.getInvestorDashboard('7', 6);
    expect(investorRepo.findOne).toHaveBeenCalledWith({
      where: { id: '7', isDeleted: false },
    });
    expect(res.data.monthly.items).toHaveLength(6);
    expect(Object.keys(res.data.investor)).not.toContain('user_id');
  });
});

describe('vpKijXce — investorni login bilan bog`lash (admin)', () => {
  const base = { name: 'Vali', phone_number: '+998901234567' };

  it('⭐ create: user_id saqlanadi (ilgari gateway uni o`tkazmasdi)', async () => {
    const { service, investorRepo } = makeService({ linked: [] });
    await service.createInvestor({ ...base, user_id: '25' } as any, {
      id: '1',
      roles: ['superadmin'],
    });
    expect(investorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '25' }),
    );
  });

  it('create: user_id berilmasa — 0 (bog`lanmagan, avvalgidek)', async () => {
    const { service, investorRepo } = makeService({ linked: [] });
    await service.createInvestor(base as any);
    expect(investorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '0' }),
    );
  });

  it.each([['0'], ['abc'], ['-5']])('create: user_id=%s → 400', async (uid) => {
    const { service, investorRepo } = makeService({ linked: [] });
    await expectStatus(
      service.createInvestor({ ...base, user_id: uid } as any),
      400,
    );
    expect(investorRepo.save).not.toHaveBeenCalled();
  });

  it('⭐ create: login boshqa investorga bog`langan → 400', async () => {
    const { service, investorRepo } = makeService({ linked: [ME] });
    await expectStatus(
      service.createInvestor({ ...base, user_id: '25' } as any),
      400,
    );
    expect(investorRepo.save).not.toHaveBeenCalled();
  });

  it('update: user_id null → uziladi (0), audit diff yoziladi', async () => {
    const { service, investorRepo, activityLog } = makeService({
      investorById: { ...ME },
    });
    await service.updateInvestor('7', { user_id: null } as any, {
      id: '1',
      roles: ['admin'],
    });
    expect(investorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '0' }),
    );
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '1', user_role: 'admin' }),
    );
  });

  it('update: boshqa investorga bog`langan login → 400', async () => {
    const { service, investorRepo } = makeService({
      investorById: { ...ME, id: '8', user_id: '0' },
      linked: [ME],
    });
    await expectStatus(
      service.updateInvestor('8', { user_id: '25' } as any),
      400,
    );
    expect(investorRepo.save).not.toHaveBeenCalled();
  });

  it('update: o`zining user_id sini qayta yuborish — xato emas', async () => {
    const { service, investorRepo } = makeService({
      investorById: { ...ME },
      linked: [ME],
    });
    await service.updateInvestor('7', { user_id: '25' } as any);
    expect(investorRepo.save).toHaveBeenCalled();
  });
});

describe('vpKijXce — RMQ controller: payload investor_id o`qilmaydi', () => {
  function makeController() {
    const rmq: any = { ack: jest.fn(), nackForError: jest.fn() };
    const svc: any = {
      getMyProfile: jest.fn().mockResolvedValue('p'),
      getMyDashboard: jest.fn().mockResolvedValue('d'),
      getMyInvestments: jest.fn().mockResolvedValue('i'),
      getMyProfits: jest.fn().mockResolvedValue('pr'),
    };
    const ctx: any = { getPattern: () => 'x' };
    return { controller: new InvestorServiceController(rmq, svc), svc, ctx };
  }

  it('⭐ investor.me.investments — faqat ruxsat etilgan query maydonlari', async () => {
    const { controller, svc, ctx } = makeController();
    await controller.meInvestments(
      {
        requester: INVESTOR_REQ,
        investor_id: '26',
        query: { investor_id: '26', page: 2, from_date: '2026-01-01' },
      } as any,
      ctx,
    );
    expect(svc.getMyInvestments).toHaveBeenCalledWith(INVESTOR_REQ, {
      from_date: '2026-01-01',
      to_date: undefined,
      page: 2,
      limit: undefined,
    });
  });

  it('investor.me.profits / profile / dashboard — faqat requester', async () => {
    const { controller, svc, ctx } = makeController();
    await controller.meProfits(
      {
        requester: INVESTOR_REQ,
        query: { investor_id: '26', is_paid: false },
      } as any,
      ctx,
    );
    expect(svc.getMyProfits).toHaveBeenCalledWith(INVESTOR_REQ, {
      is_paid: false,
      page: undefined,
      limit: undefined,
    });
    await controller.meProfile(
      { requester: INVESTOR_REQ, investor_id: '26' } as any,
      ctx,
    );
    expect(svc.getMyProfile).toHaveBeenCalledWith(INVESTOR_REQ);
    await controller.meDashboard(
      { requester: INVESTOR_REQ, query: { months: 6 } } as any,
      ctx,
    );
    expect(svc.getMyDashboard).toHaveBeenCalledWith(INVESTOR_REQ, 6);
  });
});
