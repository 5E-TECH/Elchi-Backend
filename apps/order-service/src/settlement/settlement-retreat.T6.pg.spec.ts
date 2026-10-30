import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IdempotencyKey, SettlementStatus } from '@app/common';
import { OrderSettlementService } from './order-settlement.service';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';

/**
 * T6-BE-3 — `order.settlement.retreat` + manfiy qoldiq, haqiqiy Postgres
 * (ORDER_SETTLEMENT_PG_TEST_URI bo'lmasa skip; o'z per-run sxemasida).
 *
 * Invariant: kuryer qarzi = Σ PENDING − qoldiq (`getCourierSettlementScope`)
 * har qadamda kassa bilan bir xil:
 *   • qoldiqdan olinadi → qayta ochilmaydi;
 *   • yetmasa — eng YANGI COURIER_SETTLED / HQ BRANCH_SETTLED qator PENDING,
 *     ortig'i qoldiqqa;
 *   • keyingi bo'g'inga o'tgan qatorlar tegilmaydi → MANFIY qoldiq, keyingi
 *     to'lov AVVAL uni yopadi;
 *   • market: MARKET_SETTLED → BRANCH_SETTLED;
 *   • takroriy `request_id` — hech narsa.
 */
const pgUri = process.env.ORDER_SETTLEMENT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('T6-BE-3 settlement retreat — haqiqiy Postgres', () => {
  const schema = `spec_t6_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: OrderSettlementService;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [OrderSettlement, OrderSettlementCarry, IdempotencyKey],
      synchronize: true,
    });
    await db.initialize();
    service = new OrderSettlementService(
      db,
      db.getRepository(OrderSettlement),
      { send: jest.fn() } as never,
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
    await db.query(
      `TRUNCATE "${schema}".order_settlement, "${schema}".order_settlement_carry,
        "${schema}".idempotency_keys RESTART IDENTITY`,
    );
  });

  let seq = 0;
  const row = async (input: {
    courier_id?: string | null;
    branch_id?: string | null;
    market_id?: string | null;
    courier_amount?: number;
    market_amount?: number;
    status: SettlementStatus;
  }) => {
    seq += 1;
    const saved = await db.getRepository(OrderSettlement).save(
      db.getRepository(OrderSettlement).create({
        order_id: String(1000 + seq),
        courier_id: input.courier_id ?? null,
        branch_id: input.branch_id ?? null,
        market_id: input.market_id ?? null,
        courier_amount: input.courier_amount ?? 0,
        market_amount: input.market_amount ?? 0,
        status: input.status,
      }),
    );
    // createdAt tartibi aniq bo'lsin.
    await db.query(
      `UPDATE "${schema}".order_settlement SET "createdAt" = now() + ($1 || ' seconds')::interval WHERE id = $2`,
      [String(seq), saved.id],
    );
    return saved;
  };

  const statusOf = async (id: string) =>
    (await db.getRepository(OrderSettlement).findOneByOrFail({ id })).status;

  const carry = async (level: string, party: string) =>
    Number(
      (
        await db
          .getRepository(OrderSettlementCarry)
          .findOneBy({ level, party_id: party })
      )?.amount ?? 0,
    );

  const debt = async (courierId: string) => {
    const res = (await service.getCourierSettlementScope({
      courier_id: courierId,
    })) as {
      data: {
        hq_pending_amount: number;
        branch_pending_amount: number;
        carry_amount: number;
      };
    };
    return (
      res.data.hq_pending_amount +
      res.data.branch_pending_amount -
      res.data.carry_amount
    );
  };

  const advance = (match: string, amount: number, token: string) =>
    service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: match,
      amount,
      request_id: token,
    });

  it('⭐ HQ kuryeri: to`lov → qaytarish → qarz tiklanadi; takror — hech narsa', async () => {
    const a = await row({
      courier_id: '7',
      courier_amount: 300_000,
      status: SettlementStatus.PENDING,
    });
    const b = await row({
      courier_id: '7',
      courier_amount: 200_000,
      status: SettlementStatus.PENDING,
    });
    expect(await debt('7')).toBe(500_000);

    await advance('7', 550_000, 'pay-1'); // ikkalasi yopiladi, 50 000 qoldiq
    expect(await statusOf(a.id)).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(await statusOf(b.id)).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(await carry('courier_to_branch', '7')).toBe(50_000);
    expect(await debt('7')).toBe(-50_000); // kassa: 500 000 − 550 000

    const res = await service.retreatSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 550_000,
      request_id: 'pc:1:courier_to_branch',
    });
    expect(res.data).toMatchObject({ reopened: 500_000 });
    expect(await statusOf(a.id)).toBe(SettlementStatus.PENDING);
    expect(await statusOf(b.id)).toBe(SettlementStatus.PENDING);
    expect(await carry('courier_to_branch', '7')).toBe(0);
    expect(await debt('7')).toBe(500_000);

    // Takroriy yetkazish — o'zgarish yo'q.
    const again = await service.retreatSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 550_000,
      request_id: 'pc:1:courier_to_branch',
    });
    expect(again.data).toMatchObject({ replayed: true });
    expect(await debt('7')).toBe(500_000);
  });

  it('qoldiqdan olinadi, eng YANGI qator ochiladi, ortig`i qoldiqqa', async () => {
    const old = await row({
      courier_id: '8',
      branch_id: '15',
      courier_amount: 100_000,
      status: SettlementStatus.COURIER_SETTLED,
    });
    const newest = await row({
      courier_id: '8',
      branch_id: '15',
      courier_amount: 100_000,
      status: SettlementStatus.COURIER_SETTLED,
    });
    await db.getRepository(OrderSettlementCarry).save({
      level: 'courier_to_branch',
      party_id: '8',
      branch_id: '15',
      amount: 30_000,
    });
    const before = await debt('8'); // 0 − 30 000
    await service.retreatSettlement({
      level: 'courier_to_branch',
      match_value: '8',
      amount: 80_000,
      request_id: 'pc:2:c',
    });
    // 30 000 qoldiqdan, 50 000 — eng yangi qator (100 000) ochiladi, 50 000 ortig'i qoldiqqa.
    expect(await statusOf(newest.id)).toBe(SettlementStatus.PENDING);
    expect(await statusOf(old.id)).toBe(SettlementStatus.COURIER_SETTLED);
    expect(await carry('courier_to_branch', '8')).toBe(50_000);
    expect(await debt('8')).toBe(before + 80_000);
  });

  it('⭐ keyingi bo`g`inga o`tgan qatorlar → MANFIY qoldiq; keyingi to`lov avval uni yopadi', async () => {
    const moved = await row({
      courier_id: '9',
      branch_id: '15',
      courier_amount: 400_000,
      status: SettlementStatus.BRANCH_SETTLED, // filial HQ'ga bergan
    });
    await service.retreatSettlement({
      level: 'courier_to_branch',
      match_value: '9',
      amount: 400_000,
      request_id: 'pc:3:c',
    });
    expect(await statusOf(moved.id)).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(await carry('courier_to_branch', '9')).toBe(-400_000);
    expect(await debt('9')).toBe(400_000);

    const fresh = await row({
      courier_id: '9',
      branch_id: '15',
      courier_amount: 100_000,
      status: SettlementStatus.PENDING,
    });
    expect(await debt('9')).toBe(500_000);
    // 450 000 to'lov: avval −400 000 yopiladi, qolgan 50 000 yangi qatorga sig'maydi.
    await advance('9', 450_000, 'pay-9a');
    expect(await statusOf(fresh.id)).toBe(SettlementStatus.PENDING);
    expect(await carry('courier_to_branch', '9')).toBe(50_000);
    expect(await debt('9')).toBe(50_000);
    await advance('9', 50_000, 'pay-9b');
    expect(await statusOf(fresh.id)).toBe(SettlementStatus.COURIER_SETTLED);
    expect(await carry('courier_to_branch', '9')).toBe(0);
    expect(await debt('9')).toBe(0);
  });

  it('market: MARKET_SETTLED → BRANCH_SETTLED (eng yangisi); branch_to_hq — 400', async () => {
    const m1 = await row({
      market_id: '501',
      market_amount: 200_000,
      status: SettlementStatus.MARKET_SETTLED,
    });
    const m2 = await row({
      market_id: '501',
      market_amount: 150_000,
      status: SettlementStatus.MARKET_SETTLED,
    });
    await service.retreatSettlement({
      level: 'hq_to_market',
      match_value: '501',
      amount: 150_000,
      request_id: 'pc:4:hq_to_market',
    });
    expect(await statusOf(m2.id)).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(await statusOf(m1.id)).toBe(SettlementStatus.MARKET_SETTLED);
    expect(await carry('hq_to_market', '501')).toBe(0);

    await expect(
      service.retreatSettlement({
        level: 'branch_to_hq' as never,
        match_value: '15',
        amount: 1,
      }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
  });
  it('⭐ qabul qiluvchi bo`yicha: kuryer HQ → filial B ga o`tgan; eski HQ to`lovi qaytarilsa faqat HQ qatorlari ochiladi', async () => {
    const hq = await row({
      courier_id: '10',
      courier_amount: 100_000,
      status: SettlementStatus.BRANCH_SETTLED, // HQ'da qabul qilingan
    });
    const b = await row({
      courier_id: '10',
      branch_id: '22',
      courier_amount: 100_000,
      status: SettlementStatus.COURIER_SETTLED, // keyin filial B da
    });
    await service.retreatSettlement({
      level: 'courier_to_branch',
      match_value: '10',
      amount: 100_000,
      request_id: 'pc:20:courier_to_branch',
      receiver_cashbox_type: 'main',
      receiver_branch_id: null,
    });
    expect(await statusOf(hq.id)).toBe(SettlementStatus.PENDING);
    expect(await statusOf(b.id)).toBe(SettlementStatus.COURIER_SETTLED);

    // Filial B qabul qilgan to'lov — faqat B qatorlari; yetmagani manfiy, B bilan.
    await service.retreatSettlement({
      level: 'courier_to_branch',
      match_value: '10',
      amount: 150_000,
      request_id: 'pc:21:courier_to_branch',
      receiver_cashbox_type: 'branch',
      receiver_branch_id: '22',
    });
    expect(await statusOf(b.id)).toBe(SettlementStatus.PENDING);
    const carryRow = await db
      .getRepository(OrderSettlementCarry)
      .findOneByOrFail({ level: 'courier_to_branch', party_id: '10' });
    expect(Number(carryRow.amount)).toBe(-50_000);
    expect(carryRow.branch_id).toBe('22');
  });

  it('⭐ click_to_market tartibi: avval hq_to_market, keyin courier_to_branch — MARKET_SETTLED qator PENDING gacha', async () => {
    const r = await row({
      courier_id: '11',
      market_id: '601',
      courier_amount: 80_000,
      market_amount: 80_000,
      status: SettlementStatus.MARKET_SETTLED,
    });
    await service.retreatSettlement({
      level: 'hq_to_market',
      match_value: '601',
      amount: 80_000,
      request_id: 'pc:30:hq_to_market',
      receiver_cashbox_type: 'main',
    });
    expect(await statusOf(r.id)).toBe(SettlementStatus.BRANCH_SETTLED);
    await service.retreatSettlement({
      level: 'courier_to_branch',
      match_value: '11',
      amount: 80_000,
      request_id: 'pc:30:courier_to_branch',
      receiver_cashbox_type: 'main',
    });
    expect(await statusOf(r.id)).toBe(SettlementStatus.PENDING);
    expect(await carry('courier_to_branch', '11')).toBe(0);
    expect(await carry('hq_to_market', '601')).toBe(0);
  });

  it('⭐ poyga: FIFO qulf kutgan qatorni boshqa tranzaksiya qayta ochsa — FIFO uni bosib ketmaydi', async () => {
    const r = await row({
      courier_id: '12',
      branch_id: '33',
      courier_amount: 50_000,
      status: SettlementStatus.COURIER_SETTLED,
    });
    await db.query(
      `UPDATE "${schema}".order_settlement SET branch_amount = 50000 WHERE id = $1`,
      [r.id],
    );
    const qr = db.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query(
      `SELECT id FROM "${schema}".order_settlement WHERE id = $1 FOR UPDATE`,
      [r.id],
    );
    const fifo = service.advanceSettlement({
      level: 'branch_to_hq',
      match_value: '33',
      amount: 50_000,
      request_id: 'race-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await qr.query(
      `UPDATE "${schema}".order_settlement SET status = 'pending' WHERE id = $1`,
      [r.id],
    );
    await qr.commitTransaction();
    await qr.release();
    await fifo;
    expect(await statusOf(r.id)).toBe(SettlementStatus.PENDING);
    expect(await carry('branch_to_hq', '33')).toBe(50_000);
  });
});
