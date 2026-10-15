const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
}));

import { RpcException } from '@nestjs/microservices';
import { Cashbox_type } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';
import { ReceivableStatus } from './entities/provider-receivable.entity';
import { RemittanceStatus } from './entities/provider-remittance.entity';

/**
 * utIffRFx — remittance qoldig'i (`settled_amount` / `unapplied_amount`)
 * saqlanadi va javobda `warning`.
 * DxdZFdIk — remittance ro'yxati va bekor qilish (status=cancelled, qarz
 * qatorlari PENDING, MAIN kassadan teskari chiqim BIR MARTA).
 */

type Row = Record<string, any>;

function makeSvc(
  opts: {
    pending?: Row[];
    remittance?: Row | null;
    /** utIffRFx 4-band — hamkor avansi hovuzi (so'm) — SQL SUM natijasi. */
    advance?: number;
    consumers?: Row[];
  } = {},
) {
  const svc: any = Object.create(IntegrationServiceService.prototype);
  svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  svc.integrationRepo = {
    findOne: jest.fn(() => Promise.resolve({ id: '2', slug: 'test-kargo' })),
  };
  // utIffRFx 4-band — avans SUM so'rovi (computeRemittanceAdvance).
  const advanceQb: any = {
    select: jest.fn(() => advanceQb),
    where: jest.fn(() => advanceQb),
    andWhere: jest.fn(() => advanceQb),
    getRawOne: jest.fn(() =>
      Promise.resolve({ advance: String(opts.advance ?? 0) }),
    ),
  };
  const remittanceStore: Row = opts.remittance
    ? { ...opts.remittance }
    : { id: '77' };
  const remittanceRepo = {
    create: jest.fn((x: Row) => ({ ...x })),
    save: jest.fn((x: Row) => {
      Object.assign(remittanceStore, x, { id: remittanceStore.id ?? '77' });
      return Promise.resolve({ ...remittanceStore });
    }),
    findOne: jest.fn(() =>
      Promise.resolve(opts.remittance === null ? null : { ...remittanceStore }),
    ),
    find: jest.fn(() => Promise.resolve(opts.consumers ?? [])),
    createQueryBuilder: jest.fn(() => advanceQb),
  };
  const receivables = (opts.pending ?? []).map((r) => ({ ...r }));
  const receivableRepo = {
    find: jest.fn((q: { where: Row }) =>
      Promise.resolve(
        receivables.filter((r) =>
          Object.entries(q.where).every(([k, v]) =>
            k === 'order_id' || k === 'isDeleted' ? true : r[k] === v,
          ),
        ),
      ),
    ),
    save: jest.fn((x: Row) => Promise.resolve(x)),
  };
  // advisory qulf (lockRemittanceFlow) — manager.query.
  const managerQuery = jest.fn(() => Promise.resolve([]));
  const transaction = jest.fn((cb: (m: any) => Promise<unknown>) =>
    cb({
      query: managerQuery,
      getRepository: (entity: { name?: string }) =>
        entity?.name === 'ProviderRemittance' ? remittanceRepo : receivableRepo,
    }),
  );
  svc.receivableRepo = { manager: { transaction } };
  svc.remittanceRepo = {
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    findOne: remittanceRepo.findOne,
    find: remittanceRepo.find,
    createQueryBuilder: remittanceRepo.createQueryBuilder,
    findAndCount: jest.fn(() => Promise.resolve([[], 0])),
  };
  svc.financeClient = { name: 'FINANCE' };
  svc.orderClient = { name: 'ORDER' };
  svc.activityLog = { log: jest.fn(() => Promise.resolve()) };
  return {
    svc,
    remittanceRepo,
    receivableRepo,
    receivables,
    remittanceStore,
    transaction,
    managerQuery,
    advanceQb,
  };
}

const pendingRows = () => [
  {
    id: '1',
    order_id: '1001',
    amount: '1200000.00',
    status: ReceivableStatus.PENDING,
    integration_id: '2',
  },
  {
    id: '2',
    order_id: '1002',
    amount: '2000000.00',
    status: ReceivableStatus.PENDING,
    integration_id: '2',
  },
];

const callsOf = (cmd: string) =>
  rmqSendMock.mock.calls.filter((c: any[]) => c[1]?.cmd === cmd);

beforeEach(() => {
  rmqSendMock.mockReset();
  rmqSendMock.mockResolvedValue({ statusCode: 200 });
});

describe('utIffRFx — remittance qoldig`i', () => {
  it('⭐ amount = outstanding + 1 000 000 → unapplied_amount 1 000 000, warning, qoldiq yozuvda saqlanadi', async () => {
    const env = makeSvc({ pending: pendingRows() });

    const res: any = await env.svc.createRemittance({
      integration_id: '2',
      amount: 4_200_000,
      created_by: '1',
    });

    expect(res.data).toMatchObject({
      remitted_amount: 4_200_000,
      settled_amount: 3_200_000,
      settled_count: 2,
      unapplied_amount: 1_000_000,
    });
    expect(res.data.warning).toContain('1000000');
    expect(env.remittanceStore).toMatchObject({
      settled_count: 2,
      settled_amount: '3200000.00',
      unapplied_amount: '1000000.00',
    });
    // Kassaga baribir TO'LIQ summa (o'zgarmagan xatti-harakat).
    expect(callsOf('finance.cashbox.fill')[0][2]).toMatchObject({
      amount: 4_200_000,
      cashbox_type: Cashbox_type.MAIN,
    });
  });

  it('qarzga aynan teng to`lov — warning yo`q, unapplied 0', async () => {
    const env = makeSvc({ pending: pendingRows() });

    const res: any = await env.svc.createRemittance({
      integration_id: '2',
      amount: 3_200_000,
    });

    expect(res.data.unapplied_amount).toBe(0);
    expect(res.data).not.toHaveProperty('warning');
    expect(env.remittanceStore.unapplied_amount).toBe('0.00');
  });

  it('aniq buyurtmalar ro`yxati to`lovdan ko`p yopsa — manfiy qoldiq va warning', async () => {
    const env = makeSvc({ pending: pendingRows() });

    const res: any = await env.svc.createRemittance({
      integration_id: '2',
      amount: 1_000_000,
      order_ids: ['1001', '1002'],
    });

    expect(res.data.unapplied_amount).toBe(-2_200_000);
    expect(res.data.warning).toContain('2200000');
  });

  it('DxdZFdIk: cashbox_posted yozuvga saqlanadi (true / false)', async () => {
    const ok = makeSvc({ pending: [] });
    await ok.svc.createRemittance({ integration_id: '2', amount: 10 });
    expect(ok.svc.remittanceRepo.update).toHaveBeenCalledWith(
      { id: '77' },
      { cashbox_posted: true },
    );

    rmqSendMock.mockRejectedValue(new Error('finance down'));
    const failed = makeSvc({ pending: [] });
    await failed.svc.createRemittance({ integration_id: '2', amount: 10 });
    expect(failed.svc.remittanceRepo.update).toHaveBeenCalledWith(
      { id: '77' },
      { cashbox_posted: false },
    );
  });
});

describe('DxdZFdIk — remittance ro`yxati', () => {
  it('integration_id, Toshkent kuni oralig`i, sahifalash; summalar raqam', async () => {
    const env = makeSvc();
    env.svc.remittanceRepo.findAndCount.mockResolvedValue([
      [
        {
          id: '77',
          integration_id: '2',
          createdAt: new Date('2026-10-10T05:00:00Z'),
          amount: '5000000.00',
          settled_count: 2,
          settled_amount: '3200000.00',
          unapplied_amount: '1800000.00',
          reference: 'PAY-001',
          note: 'Oktabr',
          created_by: '1',
          status: 'active',
          cashbox_posted: true,
        },
      ],
      21,
    ]);

    const res: any = await env.svc.listRemittances({
      integration_id: '2',
      from_date: '2026-10-01',
      to_date: '2026-10-14',
      page: 2,
      limit: 10,
    });

    const args = env.svc.remittanceRepo.findAndCount.mock.calls[0][0];
    expect(args.where.integration_id).toBe('2');
    expect(args.where.isDeleted).toBe(false);
    expect(args.where.createdAt.value).toEqual([
      new Date('2026-09-30T19:00:00.000Z'),
      new Date('2026-10-14T18:59:59.999Z'),
    ]);
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(res.data.pagination).toEqual({
      total: 21,
      page: 2,
      limit: 10,
      totalPages: 3,
    });
    expect(res.data.items[0]).toMatchObject({
      id: '77',
      amount: 5_000_000,
      settled_amount: 3_200_000,
      unapplied_amount: 1_800_000,
      reference: 'PAY-001',
      note: 'Oktabr',
      status: 'active',
      cashbox_posted: true,
    });
  });

  it('eski yozuv (settled/unapplied NULL) — null qaytadi, 0 emas', async () => {
    const env = makeSvc();
    env.svc.remittanceRepo.findAndCount.mockResolvedValue([
      [{ id: '5', amount: '10.00', settled_count: 1, settled_amount: null }],
      1,
    ]);

    const res: any = await env.svc.listRemittances({ integration_id: '2' });

    expect(res.data.items[0]).toMatchObject({
      settled_amount: null,
      unapplied_amount: null,
      cashbox_posted: null,
      status: 'active',
    });
  });

  it('noto`g`ri status yoki sana → 400', async () => {
    const env = makeSvc();
    await expect(
      env.svc.listRemittances({ integration_id: '2', status: 'deleted' }),
    ).rejects.toBeInstanceOf(RpcException);
    await expect(
      env.svc.listRemittances({ integration_id: '2', from_date: 'abc' }),
    ).rejects.toBeInstanceOf(RpcException);
    await expect(
      env.svc.listRemittances({ integration_id: 'x' }),
    ).rejects.toBeInstanceOf(RpcException);
  });
});

describe('DxdZFdIk — remittance bekor qilish', () => {
  const settledRows = () => [
    {
      id: '1',
      order_id: '1001',
      amount: '1200000.00',
      status: ReceivableStatus.SETTLED,
      remittance_id: '77',
      settled_at: new Date(),
    },
    {
      id: '2',
      order_id: '1002',
      amount: '2000000.00',
      status: ReceivableStatus.SETTLED,
      remittance_id: '77',
      settled_at: new Date(),
    },
  ];
  const activeRemittance = (extra: Row = {}) => ({
    id: '77',
    integration_id: '2',
    amount: '5000000.00',
    status: RemittanceStatus.ACTIVE,
    cashbox_posted: true,
    ...extra,
  });

  it('⭐ kassaga yozilgan to`lov: MAIN kassadan teskari chiqim (idempotent token), qarz qatorlari PENDING, yozuv CANCELLED', async () => {
    const env = makeSvc({
      pending: settledRows(),
      remittance: activeRemittance(),
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
      reason: 'Summa xato',
      cancelled_by: '9',
    });

    const spend = callsOf('finance.cashbox.spend');
    expect(spend).toHaveLength(1);
    expect(spend[0][2]).toMatchObject({
      cashbox_type: Cashbox_type.MAIN,
      amount: 5_000_000,
      created_by: '9',
      dedup_epoch: 'provider-remittance-cancel:77',
    });
    expect(env.receivables.map((r) => r.status)).toEqual([
      ReceivableStatus.PENDING,
      ReceivableStatus.PENDING,
    ]);
    expect(env.receivables.every((r) => r.remittance_id === null)).toBe(true);
    expect(env.remittanceStore).toMatchObject({
      status: RemittanceStatus.CANCELLED,
      cancelled_by: '9',
      cancel_reason: 'Summa xato',
    });
    expect(callsOf('order.settlement.provider_unsettled')[0][2]).toEqual({
      order_ids: ['1001', '1002'],
      requester_id: '9',
    });
    expect(res.data).toMatchObject({
      status: RemittanceStatus.CANCELLED,
      reopened_count: 2,
      cashbox_reversed: true,
      settlement_reverted: true,
    });
    // R6: kassa chiqimi tranzaksiya va hamkor advisory qulfi ICHIDA, qarz
    // qatorlari qayta ochilishidan OLDIN (pul yechilmasa — rollback, hech
    // narsa o'zgarmaydi).
    expect(env.transaction).toHaveBeenCalledTimes(1);
    expect(env.managerQuery).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['provider-remittance:2'],
    );
    expect(env.managerQuery.mock.invocationCallOrder.at(-1)).toBeLessThan(
      rmqSendMock.mock.invocationCallOrder[0],
    );
    expect(rmqSendMock.mock.invocationCallOrder[0]).toBeLessThan(
      env.receivableRepo.save.mock.invocationCallOrder[0],
    );
  });

  it('allaqachon bekor qilingan — idempotent, kassaga qayta tegilmaydi', async () => {
    const env = makeSvc({
      remittance: activeRemittance({ status: RemittanceStatus.CANCELLED }),
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
    });

    expect(res.data.idempotent).toBe(true);
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(env.transaction).not.toHaveBeenCalled();
  });

  it('MAIN kassada mablag` yetmasa — xato, qarz qatorlari va yozuv o`zgarmaydi', async () => {
    rmqSendMock.mockRejectedValue({
      statusCode: 400,
      message: 'Insufficient cash balance',
    });
    const env = makeSvc({
      pending: settledRows(),
      remittance: activeRemittance(),
    });

    const error: unknown = await env.svc
      .cancelRemittance({ integration_id: '2', remittance_id: '77' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
    });
    expect(String((error as any).getError().message)).toContain(
      'Insufficient cash balance',
    );
    // R6: chiqim tranzaksiya ichida — u yiqilsa qarz qatorlari ham, yozuv
    // ham tegilmaydi (haqiqiy PG'da ROLLBACK — remittance-b4.pg.spec).
    expect(env.receivableRepo.save).not.toHaveBeenCalled();
    expect(env.remittanceRepo.save).not.toHaveBeenCalled();
    expect(env.remittanceStore.status).toBe(RemittanceStatus.ACTIVE);
    expect(env.receivables.map((r) => r.status)).toEqual([
      ReceivableStatus.SETTLED,
      ReceivableStatus.SETTLED,
    ]);
  });

  it('eski yozuv (cashbox_posted NULL) — reverse_cashbox berilmasa 409, hech narsa o`zgarmaydi', async () => {
    const env = makeSvc({
      pending: settledRows(),
      remittance: activeRemittance({ cashbox_posted: null }),
    });

    const error: unknown = await env.svc
      .cancelRemittance({ integration_id: '2', remittance_id: '77' })
      .catch((e: unknown) => e);

    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 409,
    });
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(env.transaction).not.toHaveBeenCalled();
  });

  it('eski yozuv + reverse_cashbox=false — kassaga tegilmaydi, qarz qatorlari baribir PENDING', async () => {
    const env = makeSvc({
      pending: settledRows(),
      remittance: activeRemittance({ cashbox_posted: null }),
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
      reverse_cashbox: false,
    });

    expect(callsOf('finance.cashbox.spend')).toHaveLength(0);
    expect(res.data.cashbox_reversed).toBe(false);
    expect(res.data.reopened_count).toBe(2);
  });

  it('kassaga yozilmagan to`lov (cashbox_posted=false) — teskari chiqim YO`Q (operator reverse_cashbox=true desa ham)', async () => {
    const env = makeSvc({
      pending: settledRows(),
      remittance: activeRemittance({ cashbox_posted: false }),
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
      reverse_cashbox: true,
    });

    expect(callsOf('finance.cashbox.spend')).toHaveLength(0);
    expect(res.data.cashbox_reversed).toBe(false);
  });

  it('tranzaksiya kassa chiqimidan keyin yiqilsa — xato + log; qayta bosish AYNI token bilan (finance takrorlamaydi)', async () => {
    const env = makeSvc({
      pending: settledRows(),
      remittance: activeRemittance(),
    });
    // R6: chiqim tranzaksiya ICHIDA yozilgan, keyin yozuvni saqlash
    // (COMMIT oldi) yiqiladi.
    env.remittanceRepo.save.mockImplementationOnce(() =>
      Promise.reject(new Error('deadlock detected')),
    );

    await expect(
      env.svc.cancelRemittance({ integration_id: '2', remittance_id: '77' }),
    ).rejects.toThrow('deadlock detected');
    expect(env.svc.logger.error).toHaveBeenCalled();
    expect(env.remittanceStore.status).toBe(RemittanceStatus.ACTIVE);

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
    });

    const tokens = callsOf('finance.cashbox.spend').map(
      (c: any[]) => c[2].dedup_epoch,
    );
    expect(tokens).toEqual([
      'provider-remittance-cancel:77',
      'provider-remittance-cancel:77',
    ]);
    expect(res.data.status).toBe(RemittanceStatus.CANCELLED);
  });

  it('settlement qaytarilmasa ham bekor qilish o`tadi (best-effort), settlement_reverted=false', async () => {
    rmqSendMock.mockImplementation((_c: unknown, pattern: { cmd: string }) =>
      pattern.cmd === 'order.settlement.provider_unsettled'
        ? Promise.reject(new Error('order down'))
        : Promise.resolve({ statusCode: 200 }),
    );
    const env = makeSvc({
      pending: settledRows(),
      remittance: activeRemittance(),
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
    });

    expect(res.data.status).toBe(RemittanceStatus.CANCELLED);
    expect(res.data.settlement_reverted).toBe(false);
    expect(env.svc.logger.warn).toHaveBeenCalled();
  });

  it('boshqa kargoning to`lovi / yo`q yozuv → 404', async () => {
    const env = makeSvc({ remittance: null });

    const error: unknown = await env.svc
      .cancelRemittance({ integration_id: '2', remittance_id: '77' })
      .catch((e: unknown) => e);

    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 404,
    });
    expect(rmqSendMock).not.toHaveBeenCalled();
  });
});

describe('utIffRFx 4-band — qoldiq hamkor avansi bo`lib keyingi to`lovda ishlatiladi', () => {
  it('⭐ avans 1 800 000 + to`lov 1 500 000 → ikkala qator FIFO yopiladi, avansdan 1 700 000 ishlatiladi, qoldiq avans 100 000', async () => {
    const env = makeSvc({ pending: pendingRows(), advance: 1_800_000 });

    const res: any = await env.svc.createRemittance({
      integration_id: '2',
      amount: 1_500_000,
      created_by: '1',
    });

    expect(res.data).toMatchObject({
      remitted_amount: 1_500_000,
      settled_amount: 3_200_000,
      settled_count: 2,
      unapplied_amount: 0,
      advance_applied: 1_700_000,
      advance_balance: 100_000,
    });
    expect(res.data).not.toHaveProperty('warning');
    expect(env.remittanceStore).toMatchObject({
      settled_amount: '3200000.00',
      unapplied_amount: '0.00',
      advance_applied: '1700000.00',
    });
    expect(env.receivables.map((r) => r.status)).toEqual([
      ReceivableStatus.SETTLED,
      ReceivableStatus.SETTLED,
    ]);
    // Kassaga faqat YANGI pul (avans allaqachon kassada).
    expect(callsOf('finance.cashbox.fill')[0][2].amount).toBe(1_500_000);
    expect(
      callsOf('order.settlement.provider_settled')[0][2].order_ids,
    ).toEqual(['1001', '1002']);
  });

  it('avans yetmasa FIFO to`liq qatorda to`xtaydi: avans 500 000 + 1 000 000 → faqat 1 200 000 qator, qoldiq avans 300 000', async () => {
    const env = makeSvc({ pending: pendingRows(), advance: 500_000 });

    const res: any = await env.svc.createRemittance({
      integration_id: '2',
      amount: 1_000_000,
    });

    expect(res.data).toMatchObject({
      settled_amount: 1_200_000,
      settled_count: 1,
      advance_applied: 200_000,
      unapplied_amount: 0,
      advance_balance: 300_000,
    });
    expect(env.receivables.map((r) => r.status)).toEqual([
      ReceivableStatus.SETTLED,
      ReceivableStatus.PENDING,
    ]);
  });

  it('to`lov o`zi yetsa avansga tegilmaydi; ortiqchasi avansga QO`SHILADI', async () => {
    const env = makeSvc({ pending: pendingRows(), advance: 400_000 });

    const res: any = await env.svc.createRemittance({
      integration_id: '2',
      amount: 4_000_000,
    });

    expect(res.data).toMatchObject({
      settled_amount: 3_200_000,
      advance_applied: 0,
      unapplied_amount: 800_000,
      advance_balance: 1_200_000,
    });
    expect(res.data.warning).toContain('AVANS');
  });

  it('aniq ro`yxat to`lovdan ko`p yopsa avval avans ishlatiladi; yetmagani manfiy qoldiq (avans manfiyga tushmaydi)', async () => {
    const env = makeSvc({ pending: pendingRows(), advance: 1_000_000 });

    const res: any = await env.svc.createRemittance({
      integration_id: '2',
      amount: 1_000_000,
      order_ids: ['1001', '1002'],
    });

    expect(res.data).toMatchObject({
      settled_amount: 3_200_000,
      advance_applied: 1_000_000,
      unapplied_amount: -1_200_000,
      advance_balance: 0,
    });
    expect(res.data.warning).toContain('1200000');
  });

  it('advisory qulf avans o`qilishi va FIFO dan OLDIN (bitta hamkor — bitta navbat)', async () => {
    const env = makeSvc({ pending: pendingRows(), advance: 0 });

    await env.svc.createRemittance({ integration_id: '2', amount: 10 });

    const lockCall = env.managerQuery.mock.calls.findIndex((c: any[]) =>
      String(c[0]).includes('pg_advisory_xact_lock'),
    );
    expect(lockCall).toBeGreaterThanOrEqual(0);
    expect(env.managerQuery.mock.calls[lockCall][1]).toEqual([
      'provider-remittance:2',
    ]);
    expect(env.managerQuery.mock.invocationCallOrder[lockCall]).toBeLessThan(
      env.advanceQb.getRawOne.mock.invocationCallOrder[0],
    );
    expect(env.advanceQb.getRawOne.mock.invocationCallOrder[0]).toBeLessThan(
      env.receivableRepo.find.mock.invocationCallOrder[0],
    );
    // Avans faqat faol, kuzatiladigan (advance_applied NOT NULL) yozuvlardan.
    const conds = env.advanceQb.andWhere.mock.calls.map((c: any[]) => c[0]);
    expect(conds).toEqual(
      expect.arrayContaining([
        'r.status = :status',
        'r.advance_applied IS NOT NULL',
      ]),
    );
  });

  it('getProviderBalance: advance_balance va payable_amount = max(0, outstanding − avans)', async () => {
    const env = makeSvc({ advance: 800_000 });
    const receivableQb: any = {
      select: jest.fn(() => receivableQb),
      addSelect: jest.fn(() => receivableQb),
      where: jest.fn(() => receivableQb),
      andWhere: jest.fn(() => receivableQb),
      getRawOne: jest.fn(() =>
        Promise.resolve({ sum: '2000000.00', count: '1' }),
      ),
    };
    env.svc.receivableRepo.createQueryBuilder = jest.fn(() => receivableQb);

    const res: any = await env.svc.getProviderBalance('2');

    expect(res.data).toEqual({
      integration_id: '2',
      outstanding_amount: 2_000_000,
      outstanding_count: 1,
      advance_balance: 800_000,
      payable_amount: 1_200_000,
    });
  });
});

describe('utIffRFx 4-band + DxdZFdIk — bekor qilish avansni to`g`ri qaytaradi', () => {
  const remittanceWithAdvance = (extra: Row = {}) => ({
    id: '77',
    integration_id: '2',
    amount: '5000000.00',
    settled_amount: '3200000.00',
    unapplied_amount: '1800000.00',
    advance_applied: '0.00',
    status: RemittanceStatus.ACTIVE,
    cashbox_posted: true,
    createdAt: new Date('2026-10-15T05:00:00Z'),
    ...extra,
  });

  it('⭐ to`lov avansi keyingi to`lovda ishlatilgan — 409, kassaga tegilmaydi, tranzaksiya ochilmaydi', async () => {
    const env = makeSvc({
      remittance: remittanceWithAdvance(),
      advance: 0, // 1 800 000 to'liq #78 da ishlatilgan
      consumers: [
        {
          id: '78',
          advance_applied: '1800000.00',
          status: RemittanceStatus.ACTIVE,
        },
      ],
    });

    const error: unknown = await env.svc
      .cancelRemittance({ integration_id: '2', remittance_id: '77' })
      .catch((e: unknown) => e);

    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 409,
    });
    expect(String((error as any).getError().message)).toContain('#78');
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(env.transaction).not.toHaveBeenCalled();
  });

  it('avans qisman ishlatilgan (hovuz 1 000 000 < hissa 1 800 000) — 409', async () => {
    const env = makeSvc({
      remittance: remittanceWithAdvance(),
      advance: 1_000_000,
    });

    const error: unknown = await env.svc
      .cancelRemittance({ integration_id: '2', remittance_id: '77' })
      .catch((e: unknown) => e);

    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 409,
    });
    expect(String((error as any).getError().message)).toContain('800000');
  });

  it('avans ishlatilmagan (hovuz = hissa) — bekor qilinadi', async () => {
    const env = makeSvc({
      remittance: remittanceWithAdvance(),
      advance: 1_800_000,
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
    });

    expect(res.data.status).toBe(RemittanceStatus.CANCELLED);
    expect(callsOf('finance.cashbox.spend')[0][2].amount).toBe(5_000_000);
  });

  it('avansdan FOYDALANGAN to`lovni bekor qilish — hissa manfiy, tekshiruvsiz o`tadi (avans hovuzga qaytadi)', async () => {
    const env = makeSvc({
      remittance: remittanceWithAdvance({
        amount: '1500000.00',
        unapplied_amount: '0.00',
        advance_applied: '1700000.00',
      }),
      advance: 0,
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
    });

    expect(res.data.status).toBe(RemittanceStatus.CANCELLED);
    expect(env.advanceQb.getRawOne).not.toHaveBeenCalled();
  });

  it('eski yozuv (advance_applied NULL) — avans tekshiruvi yo`q', async () => {
    const env = makeSvc({
      remittance: remittanceWithAdvance({ advance_applied: null }),
      advance: 0,
    });

    const res: any = await env.svc.cancelRemittance({
      integration_id: '2',
      remittance_id: '77',
    });

    expect(res.data.status).toBe(RemittanceStatus.CANCELLED);
    expect(env.advanceQb.getRawOne).not.toHaveBeenCalled();
  });
});
