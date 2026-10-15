import { of } from 'rxjs';
import { InvestorServiceService } from './investor-service.service';
import { InvestorServiceController } from './investor-service.controller';

/**
 * vpKijXce (a) — ichki yo‘l `/investors/:investor_id/investments/:id`:
 * investitsiya SHU investorniki bo‘lmasa 404 va yozuv O'ZGARMAYDI
 * (ilgari gateway yo‘ldagi investor_id ni body‘ga yozib, begona investitsiyani
 * jimgina shu investorga ko‘chirib yuborishi mumkin edi).
 */
const INVESTMENT = {
  id: '9',
  investor_id: '5',
  branch_id: null,
  amount: 1000,
  invested_at: new Date('2026-03-01T00:00:00Z'),
  description: null,
  isDeleted: false,
};

function makeService() {
  const investorRepo: any = {
    findOne: jest.fn().mockResolvedValue({ id: '5', isDeleted: false }),
  };
  const investmentRepo: any = {
    findOne: jest
      .fn()
      .mockImplementation(() => Promise.resolve({ ...INVESTMENT })),
    save: jest.fn((row: any) => Promise.resolve(row)),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new InvestorServiceService(
    investorRepo,
    investmentRepo,
    {} as any,
    activityLog,
    { send: jest.fn(() => of({})) } as any,
  );
  return { service, investmentRepo, activityLog };
}

const statusOf = (err: unknown): number | undefined =>
  (err as any)?.getError?.()?.statusCode;

describe('vpKijXce — investitsiya egasi (scope_investor_id)', () => {
  const ADMIN = { id: '17', roles: ['admin'] };

  it('⭐ PATCH: begona investor (7) yo‘lida → 404, saqlanmaydi', async () => {
    const { service, investmentRepo, activityLog } = makeService();

    const err = await service
      .updateInvestment('9', { amount: 5 } as any, ADMIN, '7')
      .catch((e: unknown) => e);

    expect(statusOf(err)).toBe(404);
    expect(investmentRepo.save).not.toHaveBeenCalled();
    expect(activityLog.logChange).not.toHaveBeenCalled();
  });

  it('PATCH: o‘z investori (5) yo‘lida → yangilanadi', async () => {
    const { service, investmentRepo } = makeService();

    await service.updateInvestment('9', { amount: 5 } as any, ADMIN, '5');

    expect(investmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '9', investor_id: '5', amount: 5 }),
    );
  });

  it('⭐ DELETE: begona investor yo‘lida → 404, o‘chirilmaydi; o‘zida → o‘chiriladi', async () => {
    const { service, investmentRepo } = makeService();

    const err = await service
      .deleteInvestment('9', ADMIN, '7')
      .catch((e: unknown) => e);
    expect(statusOf(err)).toBe(404);
    expect(investmentRepo.save).not.toHaveBeenCalled();

    await service.deleteInvestment('9', ADMIN, '5');
    expect(investmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '9', isDeleted: true }),
    );
  });

  it('tekis yo‘l (scope yo‘q) — avvalgidek ishlaydi', async () => {
    const { service, investmentRepo } = makeService();

    await service.updateInvestment('9', { amount: 7 } as any, ADMIN);
    await service.deleteInvestment('9', ADMIN);

    expect(investmentRepo.save).toHaveBeenCalledTimes(2);
  });

  it('RMQ kontrolleri scope_investor_id ni servisga uzatadi', async () => {
    const service: any = {
      updateInvestment: jest.fn().mockResolvedValue({}),
      deleteInvestment: jest.fn().mockResolvedValue({}),
    };
    const rmq: any = { ack: jest.fn(), nackForError: jest.fn() };
    const controller = new InvestorServiceController(rmq, service);
    const ctx: any = { getPattern: () => 'x' };

    await controller.updateInvestment(
      {
        id: '9',
        dto: { amount: 1 } as any,
        requester: ADMIN,
        scope_investor_id: '5',
      },
      ctx,
    );
    await controller.deleteInvestment(
      { id: '9', requester: ADMIN, scope_investor_id: '5' },
      ctx,
    );

    expect(service.updateInvestment).toHaveBeenCalledWith(
      '9',
      { amount: 1 },
      ADMIN,
      '5',
    );
    expect(service.deleteInvestment).toHaveBeenCalledWith('9', ADMIN, '5');
  });
});
