import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  FinancialSource_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { PickupVisit } from '../entities/pickup-visit.entity';
import { Shift } from '../entities/shift.entity';
import { PickupFifoService } from './pickup-fifo.service';
import { PickupVisitService } from './pickup-visit.service';

/**
 * B824gOu5 — pickup tashrifi HAQIQIY Postgres'da
 * (FINANCE_T3_PG_TEST_URI bo'lmasa skip; o'z per-run sxemasida).
 *
 * Asosiy savollar: haq market qarzini oshiradimi (market → Elchi), buyurtmaga
 * va FIFO'ga tashrif paytida tegmaydimi, takror so'rov bitta yozuvmi va
 * marketga hamma pul to'langanda buyurtmalar baribir yopiladimi.
 */
const pgUri = process.env.FINANCE_T3_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const SETTINGS = { pickup_fee: 20000, pickup_free_from_count: 10 };
const REGISTRATOR = '7';
const COURIER = '55';

describePg('B824gOu5 pickup tashrifi — haqiqiy Postgres', () => {
  const schema = `spec_pickup_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  let fifo: PickupFifoService;
  let visits: PickupVisitService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const orderCalls: Array<{ cmd: string; payload: any }> = [];
  let marketOrders: Array<Record<string, unknown>> = [];

  const nextMarket = (() => {
    let id = 1000;
    return () => String(++id);
  })();

  const seedCashbox = async (
    userId: string,
    type: Cashbox_type,
    balance: number,
  ) =>
    db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id: userId,
        cashbox_type: type,
        balance,
        balance_cash: balance,
        balance_card: 0,
      }),
    );

  const marketBox = (marketId: string) =>
    db.getRepository(Cashbox).findOneByOrFail({
      user_id: marketId,
      cashbox_type: Cashbox_type.FOR_MARKET,
    });
  const mainBox = () =>
    db.getRepository(Cashbox).findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });

  const record = (
    marketId: string,
    parcelCount: number,
    key: string = randomUUID(),
    settings: unknown = SETTINGS,
  ) =>
    visits.record({
      market_id: marketId,
      courier_id: COURIER,
      parcel_count: parcelCount,
      idempotency_key: key,
      created_by: REGISTRATOR,
      settings: settings as never,
    });

  const ledger = (marketId: string) =>
    db.getRepository(FinancialBalanceHistory).find({
      where: {
        related_user_id: marketId,
        source_type: FinancialSource_type.PICKUP_FEE,
      },
    });
  const advances = () =>
    outbox.enqueue.mock.calls.filter(
      ([, pattern]) => pattern === 'order.settlement.advance',
    );

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [
        Cashbox,
        CashboxHistory,
        CashboxCard,
        FinancialBalanceHistory,
        PickupVisit,
        Shift,
      ],
      synchronize: true,
    });
    await db.initialize();
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
        orderCalls.push({ cmd: pattern.cmd, payload });
        if (pattern.cmd === 'order.find_all') {
          return of({ data: payload?.query?.page === 1 ? marketOrders : [] });
        }
        return of({ statusCode: 200, data: {} });
      }),
    };
    fifo = new PickupFifoService(db);
    const noClient = { send: jest.fn(() => of({})) };
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      activityLog as never,
      orderClient as never,
      noClient as never,
      noClient as never,
      outbox as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fifo,
    );
    visits = new PickupVisitService(db, activityLog as never, finance);
    await seedCashbox('0', Cashbox_type.MAIN, 5_000_000);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.destroy();
  });

  beforeEach(() => {
    outbox.enqueue.mockClear();
    orderCalls.length = 0;
    marketOrders = [];
  });

  it('9 posilka: 20 000, yo`nalish market → Elchi, buyurtmaga tegilmaydi', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 200000);
    const mainBefore = Number((await mainBox()).balance);

    const res = await record(market, 9);

    expect(res.statusCode).toBe(201);
    expect(res.data).toMatchObject({
      fee: 20000,
      is_free: false,
      parcel_count: 9,
      idempotent: false,
    });
    // Market kassasi — HQ'ning marketga qarzi: 20 000 ga KAMAYDI, ya'ni
    // market bizga shuncha ko'proq qarzdor.
    expect(Number((await marketBox(market)).balance)).toBe(180000);
    // Naqd ko'chmadi.
    expect(Number((await mainBox()).balance)).toBe(mainBefore);
    const rows = await db.getRepository(CashboxHistory).find({
      where: { source_type: Source_type.PICKUP_FEE, source_user_id: market },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation_type: Operation_type.EXPENSE,
      source_id: res.data?.id,
      amount: 20000,
      balance_after: 180000,
    });
    // Daftarda KIRIM (ishora +): kompaniya foydasi.
    const fbh = await ledger(market);
    expect(fbh).toHaveLength(1);
    expect(Number(fbh[0].amount)).toBe(20000);
    expect(fbh[0].order_id).toBeNull();
    // Order-service'ga hech narsa bormaydi: settlement ham, FIFO ham yo'q.
    expect(orderCalls).toEqual([]);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('kassa invarianti: market balansi tarix yig`indisiga teng, split 0', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 0);
    await record(market, 1);
    const box = await marketBox(market);
    expect(Number(box.balance)).toBe(-20000);
    expect(Number(box.balance_cash)).toBe(-20000);
    expect(Number(box.balance_card)).toBe(0);
  });

  it('10 posilka: tekin — yozuv va 0 so`mli tarix qatori bor, pul yo`q', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 200000);

    const res = await record(market, 10);

    expect(res.data).toMatchObject({ fee: 0, is_free: true });
    expect(Number((await marketBox(market)).balance)).toBe(200000);
    expect(await ledger(market)).toHaveLength(0);
    const rows = await db.getRepository(CashboxHistory).find({
      where: { source_type: Source_type.PICKUP_FEE, source_user_id: market },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(0);
    await expect(
      db.getRepository(PickupVisit).countBy({ market_id: market }),
    ).resolves.toBe(1);
  });

  it('takroriy so`rov — bitta yozuv, ketma-ket ham, parallel ham', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 200000);
    const key = randomUUID();

    const [a, b, c] = await Promise.all([
      record(market, 5, key),
      record(market, 5, key),
      record(market, 5, key),
    ]);
    const again = await record(market, 5, key);

    const results = [a, b, c, again];
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(again.data).toMatchObject({ idempotent: true, fee: 20000 });
    await expect(
      db.getRepository(PickupVisit).countBy({ market_id: market }),
    ).resolves.toBe(1);
    expect(Number((await marketBox(market)).balance)).toBe(180000);
    expect(await ledger(market)).toHaveLength(1);
  });

  it('takror — sozlama orada o`zgargan bo`lsa ham asl haq', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
    const key = randomUUID();
    await record(market, 3, key);
    const replay = await record(market, 3, key, {
      pickup_fee: 50000,
      pickup_free_from_count: 2,
    });
    expect(replay.data).toMatchObject({ fee: 20000, idempotent: true });
    expect(Number((await marketBox(market)).balance)).toBe(80000);
  });

  it('ayni kalit boshqa tashrif bilan — 409, pul yo`q', async () => {
    const market = nextMarket();
    const other = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
    await seedCashbox(other, Cashbox_type.FOR_MARKET, 100000);
    const key = randomUUID();
    await record(market, 3, key);

    await expect(record(market, 4, key)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 409 }),
    });
    await expect(record(other, 3, key)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 409 }),
    });
    expect(Number((await marketBox(market)).balance)).toBe(80000);
    expect(Number((await marketBox(other)).balance)).toBe(100000);
  });

  it('summa va chegara faqat kelgan sozlamadan', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
    const paid = await record(market, 4, randomUUID(), {
      pickup_fee: 15000,
      pickup_free_from_count: 5,
    });
    const free = await record(market, 5, randomUUID(), {
      pickup_fee: 15000,
      pickup_free_from_count: 5,
    });
    expect(paid.data).toMatchObject({ fee: 15000, is_free: false });
    expect(free.data).toMatchObject({ fee: 0, is_free: true });
  });

  it('sozlama kelmasa — 400, hech narsa yozilmaydi', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
    await expect(record(market, 3, randomUUID(), null)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
    await expect(
      db.getRepository(PickupVisit).countBy({ market_id: market }),
    ).resolves.toBe(0);
    expect(Number((await marketBox(market)).balance)).toBe(100000);
  });

  it('market kassasi yo`q — 404', async () => {
    await expect(record('999999', 3)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 404 }),
    });
  });

  it.each([
    [{ parcel_count: 0 }],
    [{ parcel_count: 1.5 }],
    [{ market_id: 'abc' }],
    [{ courier_id: '' }],
    [{ idempotency_key: '  ' }],
    [{ occurred_at: 'kecha' }],
  ])('yaroqsiz kirish %j — 400', async (patch) => {
    await expect(
      visits.record({
        market_id: '1',
        courier_id: COURIER,
        parcel_count: 3,
        idempotency_key: randomUUID(),
        created_by: REGISTRATOR,
        settings: SETTINGS,
        ...patch,
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('haqni qo`lda yozib bo`lmaydi (updateBalance)', async () => {
    const market = nextMarket();
    await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
    await expect(
      finance.updateBalance({
        user_id: market,
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: 20000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.PICKUP_FEE,
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
    expect(Number((await marketBox(market)).balance)).toBe(100000);
  });

  describe('market to`lovi FIFO`si', () => {
    const pay = (marketId: string, amount: number, key = randomUUID()) =>
      finance.paymentsToMarket({
        market_id: marketId,
        amount,
        payment_method: PaymentMethod.CASH,
        created_by: REGISTRATOR,
        dedup_epoch: key,
      });
    const drain = () =>
      Promise.all([...(finance as any).pendingFollowUps] as Promise<void>[]);
    const writes = () =>
      orderCalls.filter((call) => call.cmd === 'order.update_normalized');

    it('pickup yo`q market — hovuz to`lovning o`zi (eski xulq)', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await pay(market, 40000);
      expect(advances()).toHaveLength(1);
      expect(advances()[0][2]).toMatchObject({
        level: 'hq_to_market',
        amount: 40000,
      });
    });

    it('hamma pul to`langanda oxirgi buyurtmalar ham yopiladi', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 200000);
      marketOrders = [
        { id: '1', status: 'sold', to_be_paid: 80000, paid_amount: 0 },
        { id: '2', status: 'sold', to_be_paid: 70000, paid_amount: 0 },
        { id: '3', status: 'sold', to_be_paid: 50000, paid_amount: 0 },
      ];
      await record(market, 9);
      expect(orderCalls).toEqual([]);
      const mainBefore = Number((await mainBox()).balance);

      // Marketga faqat sof qarz to'lanadi (haq ushlab qolingan).
      await pay(market, 180000);
      await drain();

      expect(Number((await marketBox(market)).balance)).toBe(0);
      expect(Number((await mainBox()).balance)).toBe(mainBefore - 180000);
      // Daftar va buyurtma holati YALPI summani yopadi: naqd + haq.
      expect(advances()[0][2]).toMatchObject({
        level: 'hq_to_market',
        amount: 200000,
      });
      expect(writes().map((call) => call.payload.dto.status)).toEqual([
        'paid',
        'paid',
        'paid',
      ]);
    });

    it('haq FIFO`ga bir marta olinadi', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 200000);
      await record(market, 9);
      await record(market, 2);
      await pay(market, 10000);
      await pay(market, 10000);
      expect(advances().map(([, , payload]) => payload.amount)).toEqual([
        50000, 10000,
      ]);
      const open = await db.getRepository(PickupVisit).find({
        where: { market_id: market },
      });
      expect(open.every((row) => row.fifo_applied_at)).toBe(true);
      await expect(
        fifo.claimInTx(db.manager, market, randomUUID()),
      ).resolves.toBe(0);
    });

    it('tekin tashrif hovuzga hech narsa qo`shmaydi', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await record(market, 12);
      await pay(market, 30000);
      expect(advances()[0][2]).toMatchObject({ amount: 30000 });
    });

    it('takroriy to`lov haqni ikkinchi marta olmaydi', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await record(market, 3);
      const key = randomUUID();
      await pay(market, 30000, key);
      await record(market, 3);
      const replay = await pay(market, 30000, key);
      expect(replay.data).toMatchObject({ idempotent: true });
      expect(advances()).toHaveLength(1);
      const open = await db
        .getRepository(PickupVisit)
        .find({ where: { market_id: market }, order: { id: 'ASC' } });
      expect(open.map((row) => Boolean(row.fifo_applied_at))).toEqual([
        true,
        false,
      ]);
    });

    it('to`lov rad etilsa haq ochiq qoladi (M9 qo`riqchisi o`zgarmagan)', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await record(market, 3);
      await expect(pay(market, 90000)).rejects.toMatchObject({
        error: expect.objectContaining({ statusCode: 400 }),
      });
      const [visit] = await db
        .getRepository(PickupVisit)
        .find({ where: { market_id: market } });
      expect(visit.fifo_applied_at).toBeNull();
    });

    it('T6 tahriri (`skipPickupFifo`) haqni olmaydi', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await record(market, 3);
      const applied = await db.transaction((tx) =>
        finance.applyMarketPaymentInTx(
          tx,
          {
            market_id: market,
            amount: 10000,
            payment_method: PaymentMethod.CASH,
            created_by: REGISTRATOR,
            dedup_epoch: randomUUID(),
          },
          { notify: false, skipShiftGate: true, skipPickupFifo: true },
        ),
      );
      expect(applied).toMatchObject({ pickupFifoAmount: 0 });
      expect(advances()[0][2]).toMatchObject({ amount: 10000 });
    });
  });

  describe('o`qish yo`llari', () => {
    it('market tarixi: «Pickup haqi» va tekin holat maydonlari', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await record(market, 9);
      await record(market, 10);

      const res = await finance.getCashboxByUserId({
        id: market,
        cashbox_type: Cashbox_type.FOR_MARKET,
      });

      const rows = (res as any).data.cashboxHistory as Array<any>;
      expect(rows).toHaveLength(2);
      const byCount = new Map(rows.map((row) => [row.parcel_count, row]));
      expect(byCount.get(9)).toMatchObject({
        source_type: 'pickup_fee',
        is_free: false,
        amount: 20000,
      });
      expect(byCount.get(10)).toMatchObject({
        source_type: 'pickup_fee',
        is_free: true,
        amount: 0,
      });
      expect(byCount.get(10).pickup_visit).toMatchObject({
        courier_id: COURIER,
      });
    });

    it('yig`indi: daromad, pullik va tekin tashriflar alohida', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await record(market, 9);
      await record(market, 1);
      await record(market, 11);

      const res = await visits.findAll({ market_id: market });
      expect(res?.data.summary).toEqual({
        income: 40000,
        visits: 3,
        paid_visits: 2,
        free_visits: 1,
        parcels: 21,
      });
      expect(res?.data.items).toHaveLength(3);
      const onlyFree = await visits.findAll({
        market_id: market,
        is_free: 'true',
      });
      expect(onlyFree?.data.pagination.total).toBe(1);
    });

    it('davr bo`yicha daromad (tashrif sanasi)', async () => {
      const market = nextMarket();
      await seedCashbox(market, Cashbox_type.FOR_MARKET, 100000);
      await visits.record({
        market_id: market,
        courier_id: COURIER,
        parcel_count: 2,
        occurred_at: '2031-03-10T07:00:00.000Z',
        idempotency_key: randomUUID(),
        created_by: REGISTRATOR,
        settings: SETTINGS,
      });
      const inside = await visits.incomeSummary({
        from_date: '2031-03-10',
        to_date: '2031-03-10',
      });
      const outside = await visits.incomeSummary({
        from_date: '2031-03-11',
        to_date: '2031-03-12',
      });
      expect(inside?.data).toMatchObject({ income: 20000, visits: 1 });
      expect(outside?.data).toMatchObject({ income: 0, visits: 0 });
    });
  });
});
