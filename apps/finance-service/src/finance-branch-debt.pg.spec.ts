import { randomUUID } from 'node:crypto';
import { of, throwError } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { Shift } from './entities/shift.entity';

/**
 * (2026-11-11) FILIAL kassasi qarzga ishlaydi — HQ filialdan qarzidan ortiq
 * qabul qiladi (Dilshod: «4,5 mln olishimiz kerak, 5 mln olsak — 500 ming
 * qarz bo'lib qolamiz»). `branch_schema.branches.cashbox_debt_enabled`
 * (mig 217) yoqilgan bo'lsa `paymentFromBranchToMain` filial kassasini
 * manfiyga tushiradi; daftarga TO'LIQ summa yuboriladi — ortig'i
 * `branch_to_hq` qoldig'i (HQ qarzi). O'chiq / branch-service javob bermasa /
 * filial HQ — avvalgidek 400. Haqiqiy Postgres
 * (`FINANCE_OPERATOR_PG_TEST_URI`).
 */
const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '15';

describePg('Filial kassasi qarzga ishlaydi — haqiqiy Postgres', () => {
  const schema = `spec_bdebt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  /** branch-service `branch.find_by_id` javobi (testda almashtiriladi). */
  const branch = { send: jest.fn() };
  const branchReply = (data: Record<string, unknown>) =>
    branch.send.mockImplementation(() => of({ statusCode: 200, data }));

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [Cashbox, CashboxHistory, FinancialBalanceHistory, Shift],
      synchronize: true,
    });
    await db.initialize();
    service = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
      { send: jest.fn(() => of({})) } as never,
      { send: jest.fn(() => of({})) } as never,
      outbox as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      branch as never,
    );
    jest
      .spyOn(service as any, 'tryPublishAdvanceNow')
      .mockResolvedValue(undefined);
  }, 30_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    outbox.enqueue.mockClear();
    branch.send.mockReset();
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history,
        "${schema}".financial_balance_history,
        "${schema}".cashboxes RESTART IDENTITY CASCADE`,
    );
    await seed('0', Cashbox_type.MAIN);
    await seed(BRANCH, Cashbox_type.BRANCH, 4_500_000, 200_000);
  });

  async function seed(
    user_id: string,
    cashbox_type: Cashbox_type,
    cash = 0,
    card = 0,
  ) {
    return db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id,
        cashbox_type,
        balance: cash + card,
        balance_cash: cash,
        balance_card: card,
      }),
    );
  }

  const box = (user_id: string, cashbox_type: Cashbox_type) =>
    db.getRepository(Cashbox).findOneByOrFail({ user_id, cashbox_type });

  const receive = (
    amount: number,
    dedup: string,
    extra: Record<string, unknown> = {},
  ) =>
    service.paymentFromBranchToMain({
      branch_id: BRANCH,
      amount,
      payment_method: PaymentMethod.CASH,
      created_by: '1',
      dedup_epoch: dedup,
      ...extra,
    });

  const advances = () =>
    outbox.enqueue.mock.calls
      .filter((call) => call[1] === 'order.settlement.advance')
      .map((call) => {
        const payload = call[2] as Record<string, unknown>;
        return [payload.level, payload.match_value, payload.amount];
      });

  it('o`chiq (sukut) — kassadagidan ortiq → 400, hech narsa yozilmaydi', async () => {
    branchReply({ id: BRANCH, type: 'REGIONAL', cashbox_debt_enabled: false });

    await expect(receive(5_000_000, 'gw:b-1')).rejects.toMatchObject({
      error: { statusCode: 400, message: "Naqd kassada yetarli mablag' yo'q" },
    });
    expect(Number((await box(BRANCH, Cashbox_type.BRANCH)).balance_cash)).toBe(
      4_500_000,
    );
    expect(Number((await box('0', Cashbox_type.MAIN)).balance)).toBe(0);
    expect(await db.getRepository(CashboxHistory).count()).toBe(0);
    expect(advances()).toEqual([]);
  });

  it('⭐ yoqiq — 4,5 mln o`rniga 5 mln: filial naqdi −500 000, HQ +5 mln, daftarga to`liq summa', async () => {
    branchReply({ id: BRANCH, type: 'REGIONAL', cashbox_debt_enabled: true });

    const res = await receive(5_000_000, 'gw:b-2');

    expect(res?.statusCode).toBe(200);
    const branchBox = await box(BRANCH, Cashbox_type.BRANCH);
    expect(Number(branchBox.balance_cash)).toBe(-500_000);
    expect(Number(branchBox.balance_card)).toBe(200_000);
    expect(Number(branchBox.balance)).toBe(-300_000);
    expect(Number((await box('0', Cashbox_type.MAIN)).balance_cash)).toBe(
      5_000_000,
    );
    // Ortig'i order-service'da `branch_to_hq` qoldig'i bo'lib qoladi.
    expect(advances()).toEqual([['branch_to_hq', BRANCH, 5_000_000]]);
    expect(branch.send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      expect.objectContaining({ id: BRANCH }),
    );

    // Keyingi tushum (kuryer filialga 800 000 topshirdi) qarzni yopadi.
    await service.updateBalance({
      user_id: BRANCH,
      cashbox_type: Cashbox_type.BRANCH,
      amount: 800_000,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.COURIER_PAYMENT,
      source_id: '7001',
    });
    expect(Number((await box(BRANCH, Cashbox_type.BRANCH)).balance_cash)).toBe(
      300_000,
    );
  });

  it('⭐ manfiy filial kassasiga menejer kuryer pulini qabul qiladi (kirim rad etilmaydi), chiqim baribir qat`iy', async () => {
    branchReply({ id: BRANCH, type: 'REGIONAL', cashbox_debt_enabled: true });
    await seed('209', Cashbox_type.FOR_COURIER, 335_000);
    await receive(5_000_000, 'gw:b-7');
    expect(Number((await box(BRANCH, Cashbox_type.BRANCH)).balance_cash)).toBe(
      -500_000,
    );

    // Kirim natijasi hali manfiy (−165 000) — baribir o'tadi.
    await service.paymentsFromCourier({
      courier_id: '209',
      amount: 335_000,
      payment_method: PaymentMethod.CASH,
      created_by: '8',
      dedup_epoch: 'gw:c-7',
      receiver_user_id: BRANCH,
      receiver_cashbox_type: Cashbox_type.BRANCH,
    } as never);
    expect(Number((await box(BRANCH, Cashbox_type.BRANCH)).balance_cash)).toBe(
      -165_000,
    );
    expect(Number((await box('209', Cashbox_type.FOR_COURIER)).balance)).toBe(
      0,
    );

    // Qo'lda chiqim manfiy kassadan — avvalgidek 400.
    await expect(
      service.spendMoney({
        user_id: BRANCH,
        amount: 1_000,
        cashbox_type: Cashbox_type.BRANCH,
        created_by: '8',
      } as never),
    ).rejects.toMatchObject({
      error: { statusCode: 400, message: "Naqd kassada yetarli mablag' yo'q" },
    });
  });

  it('yoqiq — karta (Asosiy, karta tanlanmagan) ham manfiyga tushadi', async () => {
    branchReply({ id: BRANCH, type: 'REGIONAL', cashbox_debt_enabled: true });

    await receive(500_000, 'gw:b-3', { payment_method: PaymentMethod.CLICK });

    const branchBox = await box(BRANCH, Cashbox_type.BRANCH);
    expect(Number(branchBox.balance_card)).toBe(-300_000);
    expect(Number(branchBox.balance_cash)).toBe(4_500_000);
    expect(Number((await box('0', Cashbox_type.MAIN)).balance_card)).toBe(
      500_000,
    );
  });

  it.each([
    ['branch-service javob bermadi', () => throwError(() => new Error('down'))],
    [
      'filial HQ (bayroq baribir yoqiq ko`rinsa ham)',
      () =>
        of({ data: { id: BRANCH, type: 'HQ', cashbox_debt_enabled: true } }),
    ],
    ['filial topilmadi', () => of({ data: null })],
    [
      'bayroq boolean emas ("true" satr)',
      () =>
        of({
          data: { id: BRANCH, type: 'REGIONAL', cashbox_debt_enabled: 'true' },
        }),
    ],
  ])('%s → yopiq (400)', async (_label, reply) => {
    branch.send.mockImplementation(reply);

    await expect(receive(5_000_000, 'gw:b-4')).rejects.toMatchObject({
      error: { statusCode: 400 },
    });
    expect(Number((await box(BRANCH, Cashbox_type.BRANCH)).balance_cash)).toBe(
      4_500_000,
    );
  });

  it('kassa doirasida — o`chiq bo`lsa ham avvalgidek o`tadi', async () => {
    branchReply({ id: BRANCH, type: 'REGIONAL', cashbox_debt_enabled: false });
    await receive(4_500_000, 'gw:b-5');
    expect(Number((await box(BRANCH, Cashbox_type.BRANCH)).balance_cash)).toBe(
      0,
    );
    expect(advances()).toEqual([['branch_to_hq', BRANCH, 4_500_000]]);
  });

  it('takroriy so`rov — bir marta', async () => {
    branchReply({ id: BRANCH, type: 'REGIONAL', cashbox_debt_enabled: true });
    await receive(5_000_000, 'gw:b-6');
    const again = await receive(5_000_000, 'gw:b-6');
    expect(again?.data).toMatchObject({ idempotent: true });
    expect(Number((await box(BRANCH, Cashbox_type.BRANCH)).balance_cash)).toBe(
      -500_000,
    );
    expect(Number((await box('0', Cashbox_type.MAIN)).balance_cash)).toBe(
      5_000_000,
    );
  });
});
