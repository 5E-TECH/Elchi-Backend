import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';

/**
 * 4-tur, A guruhi — HAQIQIY Postgres'da kassa / smena:
 *  - QTCUUgjA — smena darvozasi (FOR SHARE ↔ closeShift FOR UPDATE), kamomad;
 *  - kfdfYDik — bitta kassada bitta ochiq smena, ochilish qoldig'i;
 *  - i75GDixP — filial kassasi qo'lda chiqimda manfiyga tushmaydi;
 *  - 3PE0B03q — `transfer_source_user_id` ustuni.
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describePg('A4 — kassa/smena, haqiqiy Postgres', () => {
  const schema = `spec_a4shift_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      // 3PE0B03q — closeShift MAIN kassada konvertatsiyalarni ham o'qiydi.
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        CashboxCard,
        CashboxCardMovement,
      ],
      synchronize: true,
      extra: { max: 10 },
    });
    await db.initialize();
    service = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      db,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(() => of({ statusCode: 200 })) } as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    );
    jest
      .spyOn(service as any, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined);
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
  }, 30_000);

  afterAll(async () => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    } else {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  const cashboxRepo = () => db.getRepository(Cashbox);
  const mainCashbox = () =>
    cashboxRepo().findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });

  beforeEach(async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history, "${schema}".shifts,
        "${schema}".cashboxes RESTART IDENTITY CASCADE`,
    );
    await cashboxRepo().save([
      cashboxRepo().create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 600_000,
        balance_cash: 500_000,
        balance_card: 100_000,
      }),
      cashboxRepo().create({
        user_id: '15',
        cashbox_type: Cashbox_type.BRANCH,
        balance: 100_000,
        balance_cash: 100_000,
        balance_card: 0,
      }),
      // Filial id si (15) bilan BIR XIL raqamli kuryer kassasi — smena
      // yig'indisiga aralashmasligi kerak.
      cashboxRepo().create({
        user_id: '15',
        cashbox_type: Cashbox_type.FOR_COURIER,
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      }),
      cashboxRepo().create({
        user_id: '201',
        cashbox_type: Cashbox_type.FOR_MARKET,
        balance: 1_000_000,
        balance_cash: 1_000_000,
        balance_card: 0,
      }),
    ]);
  });

  it('QTCUUgjA: smenasiz qo`lda chiqim 400 → smena ochiladi (jonli qoldiq) → o`tadi → yopishda kamomad saqlanadi → yopilgach yana 400', async () => {
    await expect(
      service.spendMoney({ user_id: '1', amount: 10_000 }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: expect.stringMatching(/^Smena/) },
    });
    expect(await db.getRepository(CashboxHistory).count()).toBe(0);
    expect((await mainCashbox()).balance_cash).toBe(500_000);

    const opened: any = await service.openShift({ opened_by: '1' });
    expect(opened.data).toMatchObject({
      opening_balance_cash: 500_000,
      opening_balance_card: 100_000,
      cashbox_user_id: '0',
    });

    await service.spendMoney({ user_id: '1', amount: 10_000 });
    await service.fillTheCashbox({
      user_id: '1',
      amount: 2_500.5,
      type: PaymentMethod.CLICK,
    });

    const closed: any = await service.closeShift({
      closed_by: '1',
      closing_balance_cash: 489_000,
      closing_balance_card: 102_500.5,
    });
    expect(closed.data).toMatchObject({
      status: ShiftStatus.CLOSED,
      total_expense_cash: 10_000,
      total_income_card: 2_500.5,
      expected_balance_cash: 490_000,
      expected_balance_card: 102_500.5,
      discrepancy_cash: -1_000,
      discrepancy_card: 0,
    });
    const stored = await db
      .getRepository(Shift)
      .findOneByOrFail({ id: closed.data.id });
    expect(stored).toMatchObject({
      expected_balance_cash: 490_000,
      discrepancy_cash: -1_000,
      discrepancy_card: 0,
    });

    await expect(
      service.spendMoney({ user_id: '1', amount: 1 }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
  });

  it('QTCUUgjA: jarayondagi operatsiya (smena FOR SHARE) commit bo`lmaguncha closeShift kutadi va uni hisobga oladi', async () => {
    const opened: any = await service.openShift({ opened_by: '1' });
    const main = await mainCashbox();

    const inFlight = db.createQueryRunner();
    await inFlight.connect();
    await inFlight.startTransaction();
    let closeSettled = false;
    try {
      // Operatsiya smenani tekshirdi (FOR SHARE) va pul yozdi, lekin hali
      // commit qilmadi.
      await inFlight.query(
        `SELECT id FROM "${schema}".shifts WHERE id = $1 FOR SHARE`,
        [opened.data.id],
      );
      await inFlight.manager.save(
        inFlight.manager.create(CashboxHistory, {
          operation_type: Operation_type.INCOME,
          cashbox_id: main.id,
          source_type: Source_type.MANUAL_INCOME,
          amount: 7_000,
          balance_after: 607_000,
          payment_method: PaymentMethod.CASH,
        }),
      );

      const closing = service
        .closeShift({ closed_by: '1', shift_id: String(opened.data.id) })
        .then((res) => {
          closeSettled = true;
          return res;
        });
      await sleep(400);
      expect(closeSettled).toBe(false);

      await inFlight.commitTransaction();
      const closed: any = await closing;
      expect(closed.data.total_income_cash).toBe(7_000);
    } finally {
      if (inFlight.isTransactionActive) await inFlight.rollbackTransaction();
      await inFlight.release();
    }
  });

  it('QTCUUgjA: filial smenasi yig`indisiga bir xil raqamli kuryer kassasi harakati qo`shilmaydi', async () => {
    await service.openShift({ opened_by: '1', cashbox_user_id: '15' });
    await service.updateBalance({
      user_id: '15',
      cashbox_type: Cashbox_type.FOR_COURIER,
      amount: 40_000,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.SELL,
      source_id: '9001',
    });
    await service.updateBalance({
      user_id: '15',
      cashbox_type: Cashbox_type.BRANCH,
      amount: 5_000,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.SELL,
      source_id: '9001',
    });

    const closed: any = await service.closeShift({
      closed_by: '1',
      opened_by: '1',
    });
    expect(closed.data.total_income_cash).toBe(5_000);
    expect(closed.data.expected_balance_cash).toBe(105_000);
  });

  it('R6 (`all`): filial kassasi smenasi — smenasiz 400 → menejer filial smenasini ochadi → o`tadi → faqat o`z smenasini yopadi (MAIN smenasi ochiq qoladi) → yana 400', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const branchCashbox = () =>
      cashboxRepo().findOneByOrFail({
        user_id: '15',
        cashbox_type: Cashbox_type.BRANCH,
      });
    const branchSpend = () =>
      service.spendMoney({
        user_id: '15',
        amount: 10_000,
        cashbox_type: Cashbox_type.BRANCH,
        created_by: '25',
      });

    await expect(branchSpend()).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: expect.stringMatching(/filial kassasida/),
      },
    });
    expect((await branchCashbox()).balance_cash).toBe(100_000);

    const mainShift: any = await service.openShift({ opened_by: '1' });
    const branchShift: any = await service.openShift({
      opened_by: '25',
      cashbox_user_id: '15',
    });
    expect(branchShift.data).toMatchObject({
      cashbox_user_id: '15',
      opening_balance_cash: 100_000,
    });

    const ok: any = await branchSpend();
    expect(ok.statusCode).toBe(200);
    expect((await branchCashbox()).balance_cash).toBe(90_000);

    // Menejer MAIN smenasini shift_id bilan yopa olmaydi.
    await expect(
      service.closeShift({
        shift_id: String(mainShift.data.id),
        closed_by: '25',
        cashbox_user_id: '15',
      }),
    ).rejects.toMatchObject({ error: { statusCode: 404 } });

    const closed: any = await service.closeShift({
      closed_by: '25',
      cashbox_user_id: '15',
      closing_balance_cash: 90_000,
    });
    expect(closed.data).toMatchObject({
      id: branchShift.data.id,
      status: ShiftStatus.CLOSED,
      total_expense_cash: 10_000,
      expected_balance_cash: 90_000,
      discrepancy_cash: 0,
    });
    const main = await db
      .getRepository(Shift)
      .findOneByOrFail({ id: String(mainShift.data.id) });
    expect(main.status).toBe(ShiftStatus.OPEN);

    await expect(branchSpend()).rejects.toMatchObject({
      error: { statusCode: 400 },
    });
  });

  it('REGRESSIYA QTCUUgjA: sotuv oyog`i (outbox → updateBalance) smenasiz ham o`tadi', async () => {
    const res: any = await service.updateBalance({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
      amount: 25_000,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.SELL,
      source_id: '7001',
      dedup_epoch: 'ep-1',
      allow_negative: true,
    });
    expect(res.statusCode).toBe(200);
    expect((await mainCashbox()).balance_cash).toBe(525_000);
  });

  it('kfdfYDik: bitta kassada ikkinchi smena ochilmaydi (boshqa odam ham), yopilgach ochiladi', async () => {
    await service.openShift({ opened_by: '1' });
    await expect(service.openShift({ opened_by: '2' })).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: expect.stringContaining('Bu kassada allaqachon ochiq smena'),
      },
    });
    await service.closeShift({ closed_by: '2' });
    const reopened: any = await service.openShift({ opened_by: '2' });
    expect(reopened.statusCode).toBe(201);
    expect(
      await db.getRepository(Shift).countBy({ status: ShiftStatus.OPEN }),
    ).toBe(1);
  });

  it('kfdfYDik: parallel ikki ochish — faqat bittasi o`tadi (kassa qatori qulfi)', async () => {
    const results = await Promise.allSettled([
      service.openShift({ opened_by: '1' }),
      service.openShift({ opened_by: '2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.getRepository(Shift).countBy({ status: ShiftStatus.OPEN }),
    ).toBe(1);
  });

  it('i75GDixP: filial kassasi qo`lda chiqimda (naqd va click) manfiyga tushmaydi; sotuv oyog`i tushadi', async () => {
    await expect(
      service.spendMoney({
        user_id: '15',
        amount: 500_000,
        cashbox_type: Cashbox_type.BRANCH,
      }),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: "Naqd kassada yetarli mablag' yo'q" },
    });
    await expect(
      service.spendMoney({
        user_id: '15',
        amount: 1,
        type: PaymentMethod.CLICK,
        cashbox_type: Cashbox_type.BRANCH,
      }),
    ).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: "Karta hisobida yetarli mablag' yo'q",
      },
    });
    const branchAfterManual = await cashboxRepo().findOneByOrFail({
      user_id: '15',
      cashbox_type: Cashbox_type.BRANCH,
    });
    expect(branchAfterManual.balance_cash).toBe(100_000);

    await service.updateBalance({
      user_id: '15',
      cashbox_type: Cashbox_type.BRANCH,
      amount: 300_000,
      operation_type: Operation_type.EXPENSE,
      source_type: Source_type.SELL,
      source_id: '7002',
      allow_negative: true,
    });
    const branchAfterSell = await cashboxRepo().findOneByOrFail({
      user_id: '15',
      cashbox_type: Cashbox_type.BRANCH,
    });
    expect(branchAfterSell.balance_cash).toBe(-200_000);
  });

  it('3PE0B03q: marketga click to`lovda transfer_source_user_id saqlanadi, source_user_id = market', async () => {
    await service.openShift({ opened_by: '1' });
    await service.paymentsToMarket({
      market_id: '201',
      amount: 50_000,
      payment_method: PaymentMethod.CLICK,
      transfer_source_user_id: '7',
    });

    const rows = await db
      .getRepository(CashboxHistory)
      .findBy({ source_type: Source_type.MARKET_PAYMENT });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.transfer_source_user_id).toBe('7');
      expect(row.source_user_id).toBe('201');
    }
    expect((await mainCashbox()).balance_card).toBe(50_000);
  });
});
