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

/**
 * (2026-11-11) KURYER kassasi qarzga ishlaydi — kuryerdan OLDINDAN pul
 * qabul qilish. Identity'dagi `cashbox_debt_enabled` (kuryer yozuvi)
 * yoqilgan bo'lsa `paymentsFromCourier` kuryer qoldig'idan ortiq summani
 * qabul qiladi: kuryer kassasi manfiyga tushadi (kompaniya kuryerga
 * qarzdor), keyingi sotuvlar uni qoplaydi. O'chiq / identity javob bermasa —
 * avvalgidek 400. Haqiqiy Postgres (`FINANCE_OPERATOR_PG_TEST_URI`).
 *
 * Daftar tomoni (ortig'i `courier_to_branch` qoldig'i) — order-service
 * `settlement-m4-manager-market.pg.spec.ts` («kuryer avansi»).
 */
const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('Kuryer kassasi qarzga ishlaydi — haqiqiy Postgres', () => {
  const schema = `spec_cdebt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  /** identity `identity.user.find_by_id` javobi (testda almashtiriladi). */
  const identity = { send: jest.fn() };
  const identityUser = (data: Record<string, unknown>) =>
    identity.send.mockImplementation(() => of({ statusCode: 200, data }));

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [Cashbox, CashboxHistory, FinancialBalanceHistory],
      synchronize: true,
    });
    await db.initialize();
    service = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
      { send: jest.fn(() => of({})) } as never,
      identity as never,
      outbox as never,
    );
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
    identity.send.mockReset();
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history,
        "${schema}".financial_balance_history,
        "${schema}".cashboxes RESTART IDENTITY CASCADE`,
    );
    await seed('0', Cashbox_type.MAIN);
    await seed('15', Cashbox_type.BRANCH);
    await seed('209', Cashbox_type.FOR_COURIER, 100_000);
  });

  async function seed(user_id: string, cashbox_type: Cashbox_type, cash = 0) {
    return db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id,
        cashbox_type,
        balance: cash,
        balance_cash: cash,
        balance_card: 0,
      }),
    );
  }

  const balance = async (user_id: string, cashbox_type: Cashbox_type) =>
    Number(
      (
        await db
          .getRepository(Cashbox)
          .findOneByOrFail({ user_id, cashbox_type })
      ).balance,
    );

  const pay = (
    amount: number,
    dedup: string,
    extra: Record<string, unknown> = {},
  ) =>
    service.paymentsFromCourier({
      courier_id: '209',
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

  it('o`chiq (sukut) — qoldiqdan ortiq → 400, hech narsa yozilmaydi', async () => {
    identityUser({ role: 'courier', cashbox_debt_enabled: false });

    await expect(pay(300_000, 'gw:d-1')).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message:
          "To'lov miqdori courier qoldig'idan oshib ketdi (qoldiq: 100000)",
      },
    });
    expect(await balance('209', Cashbox_type.FOR_COURIER)).toBe(100_000);
    expect(await db.getRepository(CashboxHistory).count()).toBe(0);
    expect(advances()).toEqual([]);
  });

  it('⭐ yoqiq — oldindan to`lov o`tadi: kuryer −200 000, HQ +300 000, daftar to`liq summa bilan', async () => {
    identityUser({ role: 'courier', cashbox_debt_enabled: true });

    const res = await pay(300_000, 'gw:d-2');

    expect(res?.statusCode).toBe(201);
    expect(await balance('209', Cashbox_type.FOR_COURIER)).toBe(-200_000);
    expect(await balance('0', Cashbox_type.MAIN)).toBe(300_000);
    expect(advances()).toEqual([['courier_to_branch', '209', 300_000]]);
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      expect.objectContaining({ id: '209' }),
    );

    // Keyingi sotuv (kuryerga +250 000) avansni qoplaydi.
    await service.updateBalance({
      user_id: '209',
      cashbox_type: Cashbox_type.FOR_COURIER,
      amount: 250_000,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.SELL,
      source_id: '7001',
    });
    expect(await balance('209', Cashbox_type.FOR_COURIER)).toBe(50_000);
  });

  it('yoqiq — menejer yo`li: filial kassasiga to`liq summa', async () => {
    identityUser({ role: 'courier', cashbox_debt_enabled: true });

    await pay(300_000, 'gw:d-3', {
      receiver_user_id: '15',
      receiver_cashbox_type: Cashbox_type.BRANCH,
    });

    expect(await balance('209', Cashbox_type.FOR_COURIER)).toBe(-200_000);
    expect(await balance('15', Cashbox_type.BRANCH)).toBe(300_000);
    // Yangi kuryerda daftar qatori bo'lmasa ham avans filialniki bo'lsin.
    expect(
      outbox.enqueue.mock.calls.find(
        (call) => call[1] === 'order.settlement.advance',
      )?.[2],
    ).toMatchObject({
      level: 'courier_to_branch',
      match_value: '209',
      amount: 300_000,
      carry_branch_id: '15',
    });
  });

  it.each([
    ['identity javob bermadi', () => throwError(() => new Error('down'))],
    [
      'boshqa rol (market) — kuryer sozlamasi emas',
      () => of({ data: { role: 'market', cashbox_debt_enabled: true } }),
    ],
    ['foydalanuvchi topilmadi', () => of({ data: null })],
  ])('%s → yopiq (400)', async (_label, reply) => {
    identity.send.mockImplementation(reply);

    await expect(pay(300_000, 'gw:d-4')).rejects.toMatchObject({
      error: { statusCode: 400 },
    });
    expect(await balance('209', Cashbox_type.FOR_COURIER)).toBe(100_000);
  });

  it('qoldiq doirasida — identity umuman so`ralmaydi', async () => {
    await pay(100_000, 'gw:d-5');
    expect(identity.send).not.toHaveBeenCalled();
    expect(await balance('209', Cashbox_type.FOR_COURIER)).toBe(0);
  });

  it('takroriy so`rov — bir marta', async () => {
    identityUser({ role: 'courier', cashbox_debt_enabled: true });
    await pay(300_000, 'gw:d-6');
    const again = await pay(300_000, 'gw:d-6');
    expect(again?.data).toMatchObject({ idempotent: true });
    expect(await balance('209', Cashbox_type.FOR_COURIER)).toBe(-200_000);
  });
});
