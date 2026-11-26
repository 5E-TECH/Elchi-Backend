import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IdempotencyKey, SettlementStatus } from '@app/common';
import { OrderSettlementService } from './order-settlement.service';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';
import { OrderSettlementBranchMarketCarry } from '../entities/order-settlement-branch-market-carry.entity';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';

/**
 * (2026-11-26, ega) T6 — filial to'lovlari qaytarilganda daftar orqaga,
 * haqiqiy Postgres (ORDER_SETTLEMENT_PG_TEST_URI bo'lmasa skip; o'z
 * vaqtinchalik bazasida — Order → Branch bog'langan):
 *  • `branch_to_market` (B — filial kassasidan marketga to'lov):
 *    advance → retreat = boshlang'ich holat; avval (X, M) qoldig'i; keyingi
 *    bo'g'inga o'tgan qatorlar — filial → HQ / HQ → market MANFIY qoldig'i;
 *  • `branch_to_hq` (A / C): BRANCH_SETTLED (va filial to'lagan / market
 *    ulushi 0 bo'lgani uchun to'g'ridan-to'g'ri MARKET_SETTLED) qatorlar
 *    COURIER_SETTLED ga; HQ marketga to'lab yopganlari — manfiy qoldiq;
 *    HQ filiali — hech narsa (advance'da ham qoldiqsiz).
 * Invariant: filialning HQ'ga qarzi (`branch_payable`) va qoldiqlar —
 * to'lovdan oldingi holat bilan bir xil.
 */
const pgUri = process.env.ORDER_SETTLEMENT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const X = '15';
const M = '201';
const CS = SettlementStatus.COURIER_SETTLED;
const BS = SettlementStatus.BRANCH_SETTLED;
const MS = SettlementStatus.MARKET_SETTLED;

describePg('T6 — filial bo`g`inlarini orqaga surish (haqiqiy Postgres)', () => {
  const dbName = `spec_rtb_${randomUUID().replace(/-/g, '').slice(0, 10)}_test`;
  const schema = 'order_schema';
  let admin: DataSource;
  let db: DataSource;
  let service: OrderSettlementService;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema,
      entities: [
        Order,
        OrderItem,
        OrderTracking,
        OrderCustodyEvent,
        Branch,
        OrderSettlement,
        OrderSettlementCarry,
        OrderSettlementBranchMarketCarry,
        IdempotencyKey,
      ],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA "order_schema"');
    await db.query('CREATE SCHEMA "branch_schema"');
    await db.synchronize();
    service = new OrderSettlementService(
      db,
      db.getRepository(OrderSettlement),
      { send: jest.fn() } as never,
      // HQ filial id si — 1.
      { getHqBranchId: () => Promise.resolve('1') } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE "${schema}".order_settlement, "${schema}".order_settlement_carry,
        "${schema}".order_settlement_branch_market_carry,
        "${schema}".idempotency_keys RESTART IDENTITY`,
    );
  });

  let seq = 0;
  const row = async (o: {
    branch?: string;
    market?: string;
    branchAmount: number;
    marketAmount: number;
    status?: SettlementStatus;
  }) => {
    seq += 1;
    const branch = o.branch ?? X;
    const [order] = await db.query(
      `INSERT INTO "${schema}".orders (market_id, customer_id, home_branch_id)
       VALUES ($1, 1, $2) RETURNING id`,
      [o.market ?? M, branch],
    );
    const saved = await db.getRepository(OrderSettlement).save(
      db.getRepository(OrderSettlement).create({
        order_id: String(order.id),
        kind: 'sale' as never,
        courier_id: '209',
        branch_id: branch,
        market_id: o.market ?? M,
        courier_amount: o.branchAmount,
        branch_amount: o.branchAmount,
        market_amount: o.marketAmount,
        status: o.status ?? CS,
      }),
    );
    await db.query(
      `UPDATE "${schema}".order_settlement SET "createdAt" = now() + ($1 || ' seconds')::interval WHERE id = $2`,
      [String(seq), saved.id],
    );
    return String(saved.id);
  };

  /** Qatorning daftar holati (taqqoslash uchun). */
  const state = async (id: string) => {
    const r = await db.getRepository(OrderSettlement).findOneByOrFail({ id });
    return {
      status: r.status,
      paid: Number(r.market_paid_by_branch_amount ?? 0),
      paidAt: r.market_paid_by_branch_at != null,
      branchAt: r.branch_to_hq_at != null,
      hqAt: r.hq_to_market_at != null,
    };
  };
  const carryOf = async (level: string, party: string) => {
    const [c] = await db.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS c FROM "${schema}".order_settlement_carry
        WHERE level = $1 AND party_id = $2`,
      [level, party],
    );
    return Number(c.c);
  };
  const bmCarry = async () => {
    const [c] = await db.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS c FROM "${schema}".order_settlement_branch_market_carry
        WHERE branch_id = $1 AND market_id = $2`,
      [X, M],
    );
    return Number(c.c);
  };
  /** Filialning HQ'ga qarzi (daftar + qoldiq) — kassaga mos bo'lishi shart. */
  const branchPayable = async () =>
    Number(
      ((await service.getBranchSettlementSummary({ branch_id: X })) as any).data
        .branch_payable,
    );
  const advance = (
    level: 'branch_to_market' | 'branch_to_hq' | 'hq_to_market',
    match: string,
    amount: number,
    token: string,
  ) =>
    service.advanceSettlement({
      level,
      match_value: match,
      amount,
      request_id: token,
      requester_id: '15001',
    }) as Promise<any>;
  const retreat = (
    level: 'branch_to_market' | 'branch_to_hq',
    match: string,
    amount: number,
    token: string,
  ) =>
    service.retreatSettlement({
      level,
      match_value: match,
      amount,
      request_id: token,
      requester_id: '1',
    }) as Promise<any>;

  describe('branch_to_market (B)', () => {
    it('⭐ to`lov → qaytarish = boshlang`ich holat (to`liq va qisman qatorlar); takror — hech narsa', async () => {
      const r1 = await row({ branchAmount: 100_000, marketAmount: 80_000 });
      const r2 = await row({ branchAmount: 50_000, marketAmount: 40_000 });
      const before = {
        r1: await state(r1),
        r2: await state(r2),
        payable: await branchPayable(),
      };

      await advance('branch_to_market', `${X}:${M}`, 100_000, 'pay-b1');
      expect(await state(r1)).toMatchObject({ paid: 80_000, paidAt: true });
      expect(await state(r2)).toMatchObject({ paid: 20_000, paidAt: false });
      expect(await branchPayable()).toBe(before.payable - 100_000);

      const res = await retreat(
        'branch_to_market',
        `${X}:${M}`,
        100_000,
        'pc:1:branch_to_market',
      );
      expect(res.data).toMatchObject({
        reopened: 100_000,
        from_carry: 0,
        branch_debt: 0,
        hq_debt: 0,
      });
      expect(await state(r1)).toEqual(before.r1);
      expect(await state(r2)).toEqual(before.r2);
      expect(await branchPayable()).toBe(before.payable);
      expect(await carryOf('branch_to_hq', X)).toBe(0);
      expect(await carryOf('hq_to_market', M)).toBe(0);

      const again = await retreat(
        'branch_to_market',
        `${X}:${M}`,
        100_000,
        'pc:1:branch_to_market',
      );
      expect(again.data).toMatchObject({ reopened: 100_000 });
      expect(await state(r1)).toEqual(before.r1);
      expect(await state(r2)).toEqual(before.r2);
    });

    it('avval (X, M) musbat qoldig`i olinadi, keyin eng YANGI qatorlar', async () => {
      const r1 = await row({ branchAmount: 100_000, marketAmount: 80_000 });
      const r2 = await row({ branchAmount: 50_000, marketAmount: 40_000 });
      // Ulushdan ortiq (poyga) — 30 000 qoldiqqa.
      await advance('branch_to_market', `${X}:${M}`, 150_000, 'pay-b2');
      expect(await bmCarry()).toBe(30_000);

      const res = await retreat(
        'branch_to_market',
        `${X}:${M}`,
        50_000,
        'pc:2:branch_to_market',
      );
      expect(res.data).toMatchObject({ from_carry: 30_000, reopened: 20_000 });
      expect(await bmCarry()).toBe(0);
      // Eng yangisi (r2) qisman ochildi, eskisi (r1) tegilmadi.
      expect(await state(r2)).toMatchObject({ paid: 20_000, paidAt: false });
      expect(await state(r1)).toMatchObject({ paid: 80_000, paidAt: true });
    });

    it('⭐ keyingi bo`g`inga o`tgan qatorlar: filial HQ`ga topshirgan / HQ marketga to`lagan — manfiy qoldiqlar, HQ ikki marta to`lamaydi', async () => {
      const r1 = await row({ branchAmount: 100_000, marketAmount: 80_000 });
      const r2 = await row({ branchAmount: 50_000, marketAmount: 40_000 });
      const payableBefore = await branchPayable();

      await advance('branch_to_market', `${X}:${M}`, 100_000, 'pay-b3');
      // Filial HQ'ga qolganini topshirdi: r1 (20 000) → MARKET_SETTLED (filial
      // to'liq to'lagan), r2 (30 000) → BRANCH_SETTLED.
      await advance('branch_to_hq', X, 50_000, 'pay-h3');
      expect(await state(r1)).toMatchObject({ status: MS, hqAt: false });
      expect(await state(r2)).toMatchObject({ status: BS });
      // HQ r2 ning qolgan market qismini (20 000) to'ladi.
      await advance('hq_to_market', M, 20_000, 'pay-m3');
      expect(await state(r2)).toMatchObject({ status: MS, hqAt: true });

      const res = await retreat(
        'branch_to_market',
        `${X}:${M}`,
        100_000,
        'pc:3:branch_to_market',
      );
      expect(res.data).toMatchObject({
        reopened: 100_000,
        branch_debt: 100_000,
        hq_debt: 20_000,
      });
      // r1: HQ marketga hali to'lamagan — BRANCH_SETTLED (HQ 80 000 to'laydi).
      expect(await state(r1)).toMatchObject({
        status: BS,
        paid: 0,
        paidAt: false,
      });
      // r2: HQ o'z qismini to'lagan — qatorga tegilmaydi (qayta ochilsa ikki
      // marta to'lardi), farq HQ → market manfiy qoldig'ida.
      expect(await state(r2)).toMatchObject({ status: MS, paid: 0 });
      expect(await carryOf('hq_to_market', M)).toBe(-20_000);
      // Filial pulni qaytarib oldi (+100 000) — HQ'ga qarzi ham shuncha.
      expect(await carryOf('branch_to_hq', X)).toBe(-100_000);
      expect(await branchPayable()).toBe(payableBefore - 50_000);
    });

    it('qatorlarda topilmagan qism — ikkala manfiy qoldiqqa (pul yo`qolmaydi)', async () => {
      await row({ branchAmount: 100_000, marketAmount: 80_000 });
      await advance('branch_to_market', `${X}:${M}`, 30_000, 'pay-b4');
      const res = await retreat(
        'branch_to_market',
        `${X}:${M}`,
        50_000,
        'pc:4:branch_to_market',
      );
      expect(res.data).toMatchObject({
        reopened: 30_000,
        branch_debt: 20_000,
        hq_debt: 20_000,
      });
      expect(await carryOf('branch_to_hq', X)).toBe(-20_000);
      expect(await carryOf('hq_to_market', M)).toBe(-20_000);
    });
  });

  describe('branch_to_hq (A / C)', () => {
    it('⭐ topshiriq → qaytarish = boshlang`ich holat; market ulushi 0 qator (X737-5) ham', async () => {
      const r1 = await row({ branchAmount: 100_000, marketAmount: 80_000 });
      const r2 = await row({ branchAmount: 50_000, marketAmount: 0 });
      const before = {
        r1: await state(r1),
        r2: await state(r2),
        payable: await branchPayable(),
      };

      await advance('branch_to_hq', X, 150_000, 'pay-h5');
      expect(await state(r1)).toMatchObject({ status: BS, branchAt: true });
      expect(await state(r2)).toMatchObject({
        status: MS,
        branchAt: true,
        hqAt: true,
      });

      const res = await retreat(
        'branch_to_hq',
        X,
        150_000,
        'pc:5:branch_to_hq',
      );
      expect(res.data).toMatchObject({ reopened: 150_000, carry_after: 0 });
      expect(await state(r1)).toEqual(before.r1);
      expect(await state(r2)).toEqual(before.r2);
      expect(await branchPayable()).toBe(before.payable);
    });

    it('HQ marketga to`lab yopgan qator tegilmaydi — qismi manfiy qoldiqqa', async () => {
      const r1 = await row({ branchAmount: 100_000, marketAmount: 80_000 });
      const r2 = await row({ branchAmount: 50_000, marketAmount: 40_000 });
      await advance('branch_to_hq', X, 150_000, 'pay-h6');
      // HQ r1 ning market qismini to'ladi.
      await advance('hq_to_market', M, 80_000, 'pay-m6');
      expect(await state(r1)).toMatchObject({ status: MS });

      const res = await retreat(
        'branch_to_hq',
        X,
        150_000,
        'pc:6:branch_to_hq',
      );
      expect(res.data).toMatchObject({
        reopened: 50_000,
        carry_after: -100_000,
      });
      expect(await state(r2)).toMatchObject({ status: CS, branchAt: false });
      expect(await state(r1)).toMatchObject({ status: MS, branchAt: true });
      expect(await carryOf('branch_to_hq', X)).toBe(-100_000);
    });

    it('HQ filiali — hech narsa (advance`da ham qoldiqsiz)', async () => {
      const r1 = await row({
        branch: '1',
        branchAmount: 100_000,
        marketAmount: 80_000,
        status: BS,
      });
      const res = await retreat(
        'branch_to_hq',
        '1',
        100_000,
        'pc:7:branch_to_hq',
      );
      expect(res.data).toMatchObject({ reopened: 0, carry_after: null });
      expect(await state(r1)).toMatchObject({ status: BS });
      expect(await carryOf('branch_to_hq', '1')).toBe(0);
    });
  });
});
