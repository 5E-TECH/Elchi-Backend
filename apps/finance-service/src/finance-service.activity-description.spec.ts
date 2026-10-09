import { FinanceServiceService } from './finance-service.service';

/**
 * 2WRzdWpZ TC4 — kassa kirim/chiqimi jurnal qatorida summa o'zbekcha
 * (ming ajratgichi bilan); izoh (comment) gapga tushmaydi. Pul mantig'i
 * (`updateBalance`) bu yerda stub — u `finance-service.service.spec.ts` da.
 */
function makeService() {
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = Object.create(
    FinanceServiceService.prototype,
  ) as FinanceServiceService & Record<string, any>;
  Object.assign(service, {
    activityLog,
    updateBalance: jest
      .fn()
      .mockResolvedValue({ data: { cashbox: { id: 'cb-1' } } }),
  });
  return { service, activityLog };
}

describe('kassa jurnal gaplari (2WRzdWpZ)', () => {
  it('TC4 qo`lda chiqim: "Kassadan chiqim: 1 250 000 so`m (...)"', async () => {
    const { service, activityLog } = makeService();
    await service.spendMoney({
      user_id: '13',
      amount: 1250000,
      cashbox_type: 'main' as never,
      comment: 'Mijoz Ali +998901234567 ga qaytim',
    });
    const entry = activityLog.log.mock.calls[0][0];
    expect(entry.action).toBe('finance.manual_expense');
    expect(entry.entity_id).toBe('cb-1');
    expect(entry.description).toBe(
      "Kassadan chiqim: 1 250 000 so'm (Asosiy kassa, naqd)",
    );
    expect(entry.description).not.toMatch(/Ali|901234567/);
  });

  it('qo`lda kirim: filial kassasi, karta', async () => {
    const { service, activityLog } = makeService();
    await service.fillTheCashbox({
      user_id: '13',
      amount: 50000,
      cashbox_type: 'branch' as never,
      type: 'click' as never,
    });
    expect(activityLog.log.mock.calls[0][0].description).toBe(
      "Kassaga kirim: 50 000 so'm (Filial kassasi, karta (Click))",
    );
  });
});
