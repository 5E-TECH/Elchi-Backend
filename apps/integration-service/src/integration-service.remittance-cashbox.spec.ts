const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
}));

import { Cashbox_type } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * N3yNa6rO — kargo hisob-kitobi (remittance) summasi MAIN kassaga kirim
 * bo'lib yoziladi (audit M5). Ekran esa "kassaga yozilmaydi, qo'lda
 * kiriting" derdi — operator takrorlab, pul ikki marta hisoblanardi.
 * Endi javobda `cashbox_posted` — UI aynan shu bayroqni ko'rsatadi.
 */
function makeSvc() {
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.integrationRepo = {
    findOne: jest.fn(() => Promise.resolve({ id: '2', slug: 'test-kargo' })),
  };
  // utIffRFx 4-band — avans SUM so'rovi (hovuz bo'sh).
  const advanceQb: any = {
    select: jest.fn(() => advanceQb),
    where: jest.fn(() => advanceQb),
    andWhere: jest.fn(() => advanceQb),
    getRawOne: jest.fn(() => Promise.resolve({ advance: '0' })),
  };
  const remittanceRepo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: any) => Promise.resolve({ id: '77', ...x })),
    createQueryBuilder: jest.fn(() => advanceQb),
  };
  const receivableRepo = {
    find: jest.fn(() => Promise.resolve([])),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    update: jest.fn(() => Promise.resolve({ affected: 0 })),
  };
  svc.receivableRepo = {
    manager: {
      transaction: (cb: (m: any) => Promise<unknown>) =>
        cb({
          query: jest.fn(() => Promise.resolve([])),
          getRepository: (entity: { name?: string }) =>
            entity?.name === 'ProviderRemittance'
              ? remittanceRepo
              : receivableRepo,
        }),
    },
  };
  svc.financeClient = { name: 'FINANCE' };
  svc.orderClient = { name: 'ORDER' };
  svc.activityLog = { log: jest.fn(() => Promise.resolve()) };
  return svc;
}

describe('createRemittance — MAIN kassaga yozuv va cashbox_posted (N3yNa6rO)', () => {
  beforeEach(() => rmqSendMock.mockReset());

  it('⭐ TC2: finance.cashbox.fill MAIN ga, dedup_epoch bilan chaqiriladi; cashbox_posted=true', async () => {
    rmqSendMock.mockResolvedValue({ statusCode: 200 });
    const svc = makeSvc();

    const res: any = await svc.createRemittance({
      integration_id: '2',
      amount: 150000,
      created_by: '1',
    });

    const fill = rmqSendMock.mock.calls.find(
      (c: any[]) => c[1]?.cmd === 'finance.cashbox.fill',
    );
    expect(fill).toBeDefined();
    expect(fill![2]).toEqual(
      expect.objectContaining({
        cashbox_type: Cashbox_type.MAIN,
        amount: 150000,
        dedup_epoch: 'provider-remittance:77',
      }),
    );
    expect(res.data.cashbox_posted).toBe(true);
    expect(res.data.remittance_id).toBe('77');
  });

  it('⭐ TC: bitta remittance — finance.cashbox.fill AYNAN bir marta, P&L daftariga yozmasdan', async () => {
    rmqSendMock.mockResolvedValue({ statusCode: 200 });
    const svc = makeSvc();

    await svc.createRemittance({
      integration_id: '2',
      amount: 150000,
      created_by: '1',
    });

    const fills = rmqSendMock.mock.calls.filter(
      (c: any[]) => c[1]?.cmd === 'finance.cashbox.fill',
    );
    expect(fills).toHaveLength(1);
    // Debitor qarz yig'imi: foyda sotuvda yozilgan, kirim P&L ga kirmaydi.
    expect(fills[0][2].financial_ledger).toBeUndefined();
  });

  it('kassa yozuvi yiqilsa — remittance saqlanadi, lekin cashbox_posted=false va xato log', async () => {
    rmqSendMock.mockRejectedValue(new Error('finance down'));
    const svc = makeSvc();

    const res: any = await svc.createRemittance({
      integration_id: '2',
      amount: 150000,
    });

    expect(res.data.cashbox_posted).toBe(false);
    expect(svc.logger.error).toHaveBeenCalled();
  });
});
