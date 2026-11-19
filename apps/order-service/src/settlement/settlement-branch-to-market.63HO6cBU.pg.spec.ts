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
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';

/**
 * 63HO6cBU (P0, PR-C) — filial menejeri faqat O'Z filiali marketiga, faqat
 * FILIAL ULUSHI doirasida to'laydi; daftarda BITTA bo'g'in `branch_to_market`
 * ("X:M") faqat (home=X, branch=X, market=M, COURIER_SETTLED) qatorlarini
 * «market filial tomonidan to'langan» deb belgilaydi. Haqiqiy Postgres
 * (`ORDER_SETTLEMENT_PG_TEST_URI`).
 *
 * Sahna: filiallar X=15, Y=16; HQ qatori (branch_id NULL); marketlar M=201,
 * N=202. Har qadamdan keyin invariantlar:
 *   a) Δ(«HQ ga berilishi kerak» X) == −(menejer to'lagan summa), tiyinigacha;
 *   b) har market: HQ + filial to'lagan jami == yopilgan qatorlar Σ market_amount;
 *   c) HQ `hq_to_market` belgilangan va X ning COURIER_SETTLED qatorlarini olmaydi;
 *   d) belgilangan qatorning HQ ulushi `branch_to_hq` bilan yig'iladi, qator
 *      MARKET_SETTLED bo'ladi;
 *   e) filial kassasi (Σ kirim − Σ chiqim) == «HQ ga berilishi kerak».
 */
const pgUri = process.env.ORDER_SETTLEMENT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const X = '15';
const Y = '16';
const M = '201';
const N = '202';

describePg(
  '63HO6cBU — filial → market bitta bo`g`in (haqiqiy Postgres)',
  () => {
    // Order → Branch (`branch_schema`) qattiq bog'langan: spec o'z vaqtinchalik
    // bazasini yaratadi va oxirida o'chiradi.
    const dbName = `spec_b2m_${randomUUID().replace(/-/g, '').slice(0, 10)}_test`;
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
        // HQ filial id si — 1 (X, Y — oddiy filiallar).
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

    let seq = 0;
    const ids: Record<string, string> = {};
    /** Filial kassasi (menejer qo'li): kuryerdan + , marketga / HQ'ga − . */
    const cash: Record<string, number> = {};
    /** Marketlarga kim qancha to'lagan. */
    const paid: Record<string, number> = {};

    const row = async (
      key: string,
      o: {
        home: string | null;
        branch: string | null;
        market: string;
        branchAmount: number;
        marketAmount: number;
        status: SettlementStatus;
        kind?: string;
      },
    ) => {
      seq += 1;
      const [order] = await db.query(
        `INSERT INTO "${schema}".orders (market_id, customer_id, home_branch_id)
       VALUES ($1, 1, $2) RETURNING id`,
        [o.market, o.home],
      );
      const saved = await db.getRepository(OrderSettlement).save(
        db.getRepository(OrderSettlement).create({
          order_id: String(order.id),
          kind: (o.kind ?? 'sale') as never,
          courier_id: '209',
          branch_id: o.branch,
          market_id: o.market,
          courier_amount: o.branchAmount,
          branch_amount: o.branchAmount,
          market_amount: o.marketAmount,
          status: o.status,
        }),
      );
      await db.query(
        `UPDATE "${schema}".order_settlement SET "createdAt" = now() + ($1 || ' seconds')::interval WHERE id = $2`,
        [String(seq), saved.id],
      );
      ids[key] = String(saved.id);
      // Menejer kuryerdan branch_amount ni qabul qilgan (COURIER_SETTLED).
      if (o.branch && o.status === SettlementStatus.COURIER_SETTLED) {
        cash[o.branch] = (cash[o.branch] ?? 0) + o.branchAmount;
      }
    };

    beforeAll(async () => {
      const CS = SettlementStatus.COURIER_SETTLED;
      await row('r1', {
        home: X,
        branch: X,
        market: M,
        branchAmount: 100_000,
        marketAmount: 80_000,
        status: CS,
      });
      await row('r2', {
        home: X,
        branch: X,
        market: M,
        branchAmount: 50_000,
        marketAmount: 40_000,
        status: CS,
      });
      await row('r3', {
        home: X,
        branch: X,
        market: N,
        branchAmount: 70_000,
        marketAmount: 60_000,
        status: CS,
      });
      await row('r4', {
        home: Y,
        branch: Y,
        market: M,
        branchAmount: 90_000,
        marketAmount: 75_000,
        status: CS,
      });
      // X yetkazgan, lekin Y da yaratilgan — X ulushiga KIRMAYDI (HQ orqali).
      await row('r5', {
        home: Y,
        branch: X,
        market: M,
        branchAmount: 30_000,
        marketAmount: 25_000,
        status: CS,
      });
      // HQ o'zi yetkazgan.
      await row('r6', {
        home: null,
        branch: null,
        market: M,
        branchAmount: 20_000,
        marketAmount: 20_000,
        status: SettlementStatus.BRANCH_SETTLED,
      });
      // Manfiy qo'shimcha xarajat qaytarishi (kredit).
      await row('r7', {
        home: X,
        branch: X,
        market: M,
        branchAmount: -5_000,
        marketAmount: -5_000,
        status: CS,
        kind: 'extra_cost_reversal',
      });
    }, 60_000);

    const payable = async (branch: string) =>
      Number(
        (
          (await service.getBranchSettlementSummary({
            branch_id: branch,
          })) as any
        ).data.branch_payable,
      );
    const share = async (branch: string, market: string) =>
      (
        (await service.getBranchMarketShare({
          branch_id: branch,
          market_id: market,
        })) as any
      ).data as { in_branch: boolean; share: number };
    const statusOf = async (key: string) =>
      (
        await db
          .getRepository(OrderSettlement)
          .findOneByOrFail({ id: ids[key] })
      ).status;
    const markedOf = async (key: string) =>
      (
        await db
          .getRepository(OrderSettlement)
          .findOneByOrFail({ id: ids[key] })
      ).market_paid_by_branch_at != null;
    const managerPays = async (
      branch: string,
      market: string,
      amount: number,
      token: string,
    ) => {
      const res: any = await service.advanceSettlement({
        level: 'branch_to_market',
        match_value: `${branch}:${market}`,
        amount,
        request_id: token,
        requester_id: '15001',
      });
      if (!res?.data?.replayed) {
        cash[branch] -= amount;
        paid[market] = (paid[market] ?? 0) + amount;
      }
      return res;
    };
    const hqPaysMarket = async (
      market: string,
      amount: number,
      token: string,
    ) => {
      paid[market] = (paid[market] ?? 0) + amount;
      return service.advanceSettlement({
        level: 'hq_to_market',
        match_value: market,
        amount,
        request_id: token,
        requester_id: '1',
      });
    };
    /**
     * b) market: to'langan jami == qoplangan: MARKET_SETTLED qatorlar Σ
     * market_amount + boshqa qatorlarda filial to'lagan qism + HQ va (X, M)
     * qoldiqlari.
     */
    const marketCovered = async (market: string) => {
      const [r] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN status = 'market_settled' THEN market_amount
                                  ELSE market_paid_by_branch_amount END), 0)::float AS s
           FROM "${schema}".order_settlement
          WHERE market_id = $1 AND is_deleted = false`,
        [market],
      );
      const [c] = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS c FROM "${schema}".order_settlement_carry
        WHERE level = 'hq_to_market' AND party_id = $1`,
        [market],
      );
      const [bm] = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS c FROM "${schema}".order_settlement_branch_market_carry
        WHERE market_id = $1`,
        [market],
      );
      return Math.round((Number(r.s) + Number(c.c) + Number(bm.c)) * 100) / 100;
    };
    const carryOf = async (level: string, party: string) => {
      const [c] = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS c FROM "${schema}".order_settlement_carry
        WHERE level = $1 AND party_id = $2`,
        [level, party],
      );
      return Number(c.c);
    };
    const paidOf = async (key: string) =>
      Number(
        (
          await db
            .getRepository(OrderSettlement)
            .findOneByOrFail({ id: ids[key] })
        ).market_paid_by_branch_amount,
      );
    const expectInvariants = async () => {
      // e) filial kassasi == «HQ ga berilishi kerak» (X va Y).
      expect(await payable(X)).toBeCloseTo(cash[X], 2);
      expect(await payable(Y)).toBeCloseTo(cash[Y], 2);
      // b) har market: to'langan == qoplangan.
      for (const market of [M, N]) {
        expect(await marketCovered(market)).toBeCloseTo(paid[market] ?? 0, 2);
      }
    };

    it('0) boshlang`ich: ulush faqat (home=X, branch=X); ro`yxatda X marketlari; invariantlar', async () => {
      expect(await share(X, M)).toMatchObject({
        in_branch: true,
        share: 115_000,
      });
      expect(await share(X, N)).toMatchObject({
        in_branch: true,
        share: 60_000,
      });
      expect(await share(Y, M)).toMatchObject({
        in_branch: true,
        share: 75_000,
      });
      expect(await share(Y, N)).toEqual(
        expect.objectContaining({ in_branch: false, share: 0 }),
      );
      const list: any = await service.getBranchMarkets({ branch_id: X });
      expect(list.data.items).toEqual([
        { market_id: M, share: 115_000 },
        { market_id: N, share: 60_000 },
      ]);
      await expectInvariants();
    });

    it('1) qisman to`lov 100 000: kredit r7 + r1 to`liq, r2 QISMAN (25 000 qatorning o`zida); ulush darhol 15 000; a) Δ payable = −100 000; boshqa qoldiqlar tegilmaydi', async () => {
      const before = await payable(X);
      const res: any = await managerPays(X, M, 100_000, 'p-1');
      expect(res.data).toMatchObject({ allocated: 100_000, leftover: 0 });
      expect(await markedOf('r7')).toBe(true);
      expect(await markedOf('r1')).toBe(true);
      expect(await markedOf('r2')).toBe(false);
      expect(await paidOf('r2')).toBe(25_000);
      expect(await statusOf('r1')).toBe(SettlementStatus.COURIER_SETTLED);
      expect((await payable(X)) - before).toBeCloseTo(-100_000, 2);
      expect(await share(X, M)).toMatchObject({ share: 15_000 });
      // c, d) qisman qism boshqa bo'g'in qoldiqlariga O'TMAYDI.
      expect(await carryOf('branch_to_hq', X)).toBe(0);
      expect(await carryOf('hq_to_market', M)).toBe(0);
      for (const key of ['r3', 'r4', 'r5']) {
        expect(await markedOf(key)).toBe(false);
        expect(await paidOf(key)).toBe(0);
        expect(await statusOf(key)).toBe(SettlementStatus.COURIER_SETTLED);
      }
      await expectInvariants();
    });

    it('2) takroriy token — ikki marta yozmaydi', async () => {
      const again: any = await managerPays(X, M, 100_000, 'p-1');
      expect(again.data.replayed).toBe(true);
      expect(await paidOf('r2')).toBe(25_000);
      await expectInvariants();
    });

    it('3) c) HQ M ga o`z qarzini to`laydi — faqat r6 (HQ) yopiladi; X ning COURIER_SETTLED / qisman qatorlari va Y qatori olinmaydi', async () => {
      const res: any = await hqPaysMarket(M, 20_000, 'h-1');
      expect(res.data.settled_order_ids).toHaveLength(1);
      expect(await statusOf('r6')).toBe(SettlementStatus.MARKET_SETTLED);
      for (const key of ['r1', 'r2', 'r4', 'r5', 'r7']) {
        expect(await statusOf(key)).toBe(SettlementStatus.COURIER_SETTLED);
      }
      expect(await carryOf('hq_to_market', M)).toBe(0);
      await expectInvariants();
    });

    it('4) qolgan ulush 15 000: r2 to`liq; ulush 0; a) Δ payable = −15 000', async () => {
      const before = await payable(X);
      const res: any = await managerPays(X, M, 15_000, 'p-2');
      expect(res.data).toMatchObject({ allocated: 15_000, leftover: 0 });
      expect(await markedOf('r2')).toBe(true);
      expect(await paidOf('r2')).toBe(40_000);
      expect((await payable(X)) - before).toBeCloseTo(-15_000, 2);
      expect(await share(X, M)).toMatchObject({ share: 0 });
      await expectInvariants();
    });

    it('5) Y menejeri o`z ulushini to`laydi — faqat r4 (X qatorlari tegilmaydi)', async () => {
      await managerPays(Y, M, 75_000, 'p-y');
      expect(await markedOf('r4')).toBe(true);
      expect(await markedOf('r5')).toBe(false);
      expect(await payable(Y)).toBeCloseTo(15_000, 2);
      await expectInvariants();
    });

    it('6) d) admin X dan qisman, keyin to`liq oladi: to`liq to`langan qatorlar HQ ulushi bilan MARKET_SETTLED; qolganlari BRANCH_SETTLED', async () => {
      const take = async (amount: number, token: string) => {
        cash[X] -= amount;
        return service.advanceSettlement({
          level: 'branch_to_hq',
          match_value: X,
          amount,
          request_id: token,
          requester_id: '1',
        });
      };
      expect(cash[X]).toBe(130_000);
      await take(30_000, 'b-1'); // r1 (HQ ulushi 20 000) + r2 (10 000)
      expect(await statusOf('r1')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf('r2')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf('r3')).toBe(SettlementStatus.COURIER_SETTLED);
      await expectInvariants();
      await take(100_000, 'b-2'); // r3 70 000 + r5 30 000 + r7 0
      expect(await statusOf('r3')).toBe(SettlementStatus.BRANCH_SETTLED);
      expect(await statusOf('r5')).toBe(SettlementStatus.BRANCH_SETTLED);
      expect(await statusOf('r7')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await payable(X)).toBeCloseTo(0, 2);
      await expectInvariants();
    });

    it('7) HQ endi faqat o`z qarzini to`laydi: M — r5 (25 000), N — r3 (60 000)', async () => {
      await hqPaysMarket(M, 25_000, 'h-2');
      await hqPaysMarket(N, 60_000, 'h-3');
      expect(await statusOf('r5')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf('r3')).toBe(SettlementStatus.MARKET_SETTLED);
      // M: X 115 000 + Y 75 000 + HQ (20 000 + 25 000) = Σ market_amount.
      expect(paid[M]).toBe(80_000 + 40_000 - 5_000 + 75_000 + 25_000 + 20_000);
      await expectInvariants();
    });

    it('8) T6 retreat: HQ marketga to`lovni qaytarish filial to`lagan qatorlarni qayta ochmaydi', async () => {
      await service.retreatSettlement({
        level: 'hq_to_market',
        match_value: M,
        amount: 25_000,
        request_id: 'rt-1',
        requester_id: '1',
      });
      paid[M] -= 25_000;
      for (const key of ['r1', 'r2', 'r7']) {
        expect(await statusOf(key)).toBe(SettlementStatus.MARKET_SETTLED);
        expect(await markedOf(key)).toBe(true);
      }
      expect(await statusOf('r5')).toBe(SettlementStatus.BRANCH_SETTLED);
      await expectInvariants();
    });

    it('9) parallel ikki bir xil token — bitta yozuv', async () => {
      await row('r8', {
        home: X,
        branch: X,
        market: N,
        branchAmount: 12_000,
        marketAmount: 10_000,
        status: SettlementStatus.COURIER_SETTLED,
      });
      const results = await Promise.allSettled([
        service.advanceSettlement({
          level: 'branch_to_market',
          match_value: `${X}:${N}`,
          amount: 10_000,
          request_id: 'par-1',
          requester_id: '15001',
        }),
        service.advanceSettlement({
          level: 'branch_to_market',
          match_value: `${X}:${N}`,
          amount: 10_000,
          request_id: 'par-1',
          requester_id: '15001',
        }),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      cash[X] -= 10_000;
      paid[N] = (paid[N] ?? 0) + 10_000;
      expect(await markedOf('r8')).toBe(true);
      expect(await paidOf('r8')).toBe(10_000);
      await expectInvariants();
    });

    it('10) a, b) 10 ta ketma-ket kichik qisman to`lov: ulush har gal kamayadi (S − Σc), «HQ ga berilishi kerak» ham; yig`indi ulushdan oshmaydi', async () => {
      await row('r9', {
        home: X,
        branch: X,
        market: M,
        branchAmount: 120_000,
        marketAmount: 100_000,
        status: SettlementStatus.COURIER_SETTLED,
      });
      await expectInvariants();
      let expectedShare = 100_000;
      for (let i = 1; i <= 10; i += 1) {
        const before = await payable(X);
        const { share: current } = await share(X, M);
        expect(current).toBeCloseTo(expectedShare, 2);
        // Gateway qoidasi: summa ≤ ulush.
        expect(9_000 <= current).toBe(true);
        await managerPays(X, M, 9_000, `small-${i}`);
        expectedShare -= 9_000;
        expect((await payable(X)) - before).toBeCloseTo(-9_000, 2);
        const list: any = await service.getBranchMarkets({ branch_id: X });
        expect(
          list.data.items.find((item: any) => item.market_id === M).share,
        ).toBeCloseTo(expectedShare, 2);
        await expectInvariants();
      }
      // 11-chi: qolgan ulush 10 000 — 10 001 gateway'da 400 bo'ladi.
      const { share: left } = await share(X, M);
      expect(left).toBe(10_000);
      expect(10_001 > left).toBe(true);
      expect(await paidOf('r9')).toBe(90_000);
      expect(await markedOf('r9')).toBe(false);
      // c, d) boshqa bo'g'in qoldiqlari tegilmagan.
      expect(await carryOf('branch_to_hq', X)).toBe(0);
    });

    it('11) d) qisman to`langan r9: admin olganda r8 (HQ ulushi 2 000) + r9 (HQ ulushi 20 000 + to`lanmagan market qismi 10 000) = 32 000, BRANCH_SETTLED; HQ marketga r9 bo`yicha faqat qolganini (10 000) to`laydi', async () => {
      expect(cash[X]).toBe(32_000);
      expect(await payable(X)).toBeCloseTo(32_000, 2);
      cash[X] -= 32_000;
      await service.advanceSettlement({
        level: 'branch_to_hq',
        match_value: X,
        amount: 32_000,
        request_id: 'b-3',
        requester_id: '1',
      });
      expect(await statusOf('r8')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf('r9')).toBe(SettlementStatus.BRANCH_SETTLED);
      expect(await payable(X)).toBeCloseTo(0, 2);
      expect(await carryOf('branch_to_hq', X)).toBe(0);
      await expectInvariants();
      // HQ M ga: r5 (retreat qayta ochgan 25 000) + r9 (100 000 − 90 000).
      await hqPaysMarket(M, 35_000, 'h-4');
      expect(await statusOf('r5')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf('r9')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await carryOf('hq_to_market', M)).toBe(0);
      await expectInvariants();
    });

    it('12) poyga: ulushdan ortiq to`lov — ortig`i (X, M) qoldig`iga, boshqa joyga o`tmaydi; ulush va payable undan kamayadi; yangi (X, M) qatori paydo bo`lganda kaskad bilan qo`llanadi', async () => {
      await row('r10', {
        home: X,
        branch: X,
        market: M,
        branchAmount: 60_000,
        marketAmount: 50_000,
        status: SettlementStatus.COURIER_SETTLED,
      });
      const res: any = await managerPays(X, M, 55_000, 'race-1');
      expect(res.data).toMatchObject({ allocated: 50_000, leftover: 5_000 });
      expect(await markedOf('r10')).toBe(true);
      expect(await share(X, M)).toMatchObject({ share: -5_000 });
      expect(await carryOf('branch_to_hq', X)).toBe(0);
      expect(await carryOf('hq_to_market', M)).toBe(0);
      await expectInvariants();
      // Yangi (X, M) sotuvi — kuryer topshiradi: qoldiq faqat shu qatorga.
      seq += 1;
      const [order] = await db.query(
        `INSERT INTO "${schema}".orders (market_id, customer_id, home_branch_id) VALUES ($1, 1, $2) RETURNING id`,
        [M, X],
      );
      const saved = await db.getRepository(OrderSettlement).save(
        db.getRepository(OrderSettlement).create({
          order_id: String(order.id),
          courier_id: '209',
          branch_id: X,
          market_id: M,
          courier_amount: 24_000,
          branch_amount: 24_000,
          market_amount: 20_000,
          status: SettlementStatus.PENDING,
        }),
      );
      ids.r11 = String(saved.id);
      await service.advanceSettlement({
        level: 'courier_to_branch',
        match_value: '209',
        amount: 24_000,
        request_id: 'c-11',
        requester_id: '25',
      });
      cash[X] += 24_000;
      expect(await statusOf('r11')).toBe(SettlementStatus.COURIER_SETTLED);
      expect(await paidOf('r11')).toBe(5_000);
      expect(await share(X, M)).toMatchObject({ share: 15_000 });
      await expectInvariants();
    });

    it('12b) ulush + `applied_tokens` bitta suratda: qo`llangan tokenlar qaytadi, noma`lumi — yo`q; ro`yxat > 200 → 400', async () => {
      const res: any = await service.getBranchMarketShare({
        branch_id: X,
        market_id: M,
        pending_tokens: ['p-1', 'p-2', 'race-1', 'nope', 'p-1', 7],
      });
      expect(res.data.applied_tokens.sort()).toEqual(['p-1', 'p-2', 'race-1']);
      expect(res.data.share).toBeCloseTo((await share(X, M)).share, 2);
      await expect(
        service.getBranchMarketShare({
          branch_id: X,
          market_id: M,
          pending_tokens: Array.from({ length: 201 }, (_, i) => `t-${i}`),
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
    });

    it('13) noto`g`ri tomon / summa → 400', async () => {
      await expect(
        service.advanceSettlement({
          level: 'branch_to_market',
          match_value: '15',
          amount: 1,
          request_id: 'bad-1',
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      await expect(
        service.advanceSettlement({
          level: 'branch_to_market',
          match_value: '15:0',
          amount: 1,
          request_id: 'bad-2',
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
    });

    it('14) rollback himoyasi: filial qisman / to`liq to`lagan qatorli buyurtma qaytarilmaydi (400), daftar o`zgarmaydi', async () => {
      const lifecycle = Object.create(
        OrderLifecycleService.prototype,
      ) as Record<string, any>;
      for (const key of ['r8', 'r11']) {
        const target = await db
          .getRepository(OrderSettlement)
          .findOneByOrFail({ id: ids[key] });
        await expect(
          db.transaction((tx) =>
            lifecycle.resetSettlementOnRollback(tx, String(target.order_id)),
          ),
        ).rejects.toMatchObject({ error: { statusCode: 400 } });
        const after = await db
          .getRepository(OrderSettlement)
          .findOneByOrFail({ id: ids[key] });
        expect(after.isDeleted).toBe(false);
      }
    });

    it('15) moliyaviy xulosa: filial va market summalari filial to`lagan qismsiz', async () => {
      const summary: any = await service.getFinancialBalanceSettlementSummary();
      const data = summary.data;
      const branchX = data.branches.find((b: any) => b.branch_id === X);
      expect(branchX.amount).toBeCloseTo(await payable(X), 2);
      const marketM = data.markets.find((m: any) => m.market_id === M);
      // M bo'yicha ochiq: r10 (50 000 − 50 000 filial to'lagan = 0), r4
      // (75 000 − 75 000 = 0), r11 (20 000 − 5 000 qoldiqdan) — 15 000.
      expect(marketM.amount).toBeCloseTo(15_000, 2);
    });

    it('A2 (Y-6): 0 so`mlik qatorlar hech qachon «filial to`lagan» bo`lmaydi (tugash nuqtasidan oldin ham); branch_to_hq da odatdagidek yopiladi', async () => {
      const CS = SettlementStatus.COURIER_SETTLED;
      await row('z1', {
        home: '17',
        branch: '17',
        market: '205',
        branchAmount: 12_000,
        marketAmount: 10_000,
        status: CS,
      });
      await row('z0', {
        home: '17',
        branch: '17',
        market: '205',
        branchAmount: 500,
        marketAmount: 0,
        status: CS,
      });
      await row('z2', {
        home: '17',
        branch: '17',
        market: '205',
        branchAmount: 6_000,
        marketAmount: 5_000,
        status: CS,
      });
      await managerPays('17', '205', 10_000, 'a2-1');
      expect(await markedOf('z1')).toBe(true);
      expect(await markedOf('z0')).toBe(false);
      expect(await markedOf('z2')).toBe(false);
      await managerPays('17', '205', 5_000, 'a2-2');
      // z0 tugash nuqtasidan OLDIN turibdi (z2 to'landi) — baribir belgilanmaydi.
      expect(await markedOf('z0')).toBe(false);
      expect(await markedOf('z2')).toBe(true);
      // Filial HQ'ga: z1 (12 000 − 10 000) + z0 500 + z2 (6 000 − 5 000).
      const res: any = await service.advanceSettlement({
        level: 'branch_to_hq',
        match_value: '17',
        amount: 3_500,
        request_id: 'a2-hq',
        requester_id: '1',
      });
      expect(res.data.leftover).toBe(0);
      // Filial to'lagan qatorlar — darhol MARKET_SETTLED; WX-2: market ulushi
      // 0 bo'lgan z0 ham darhol MARKET_SETTLED (HQ marketga hech narsa
      // to'lamaydi — BRANCH_SETTLED da osilib qolmaydi), belgisiz.
      for (const key of ['z1', 'z0', 'z2']) {
        expect(await statusOf(key)).toBe(SettlementStatus.MARKET_SETTLED);
      }
      expect(await markedOf('z0')).toBe(false);
    });

    it('⭐ WX-1: migratsiya 246 konvertatsiya izi bor — ulush, ro`yxat va filial → market to`lovi 503 (kill switch), daftar o`zgarmaydi; iz bo`sh yoki yo`q — odatdagidek', async () => {
      const CS = SettlementStatus.COURIER_SETTLED;
      await row('k1', {
        home: '19',
        branch: '19',
        market: '207',
        branchAmount: 120_000,
        marketAmount: 100_000,
        status: CS,
      });
      const before = await share('19', '207');
      expect(before.share).toBe(100_000);
      // Jadval bor, lekin bo'sh — ishlaydi.
      await db.query(`CREATE TABLE "${schema}".order_settlement_246_conversion (
        "id" BIGSERIAL PRIMARY KEY, "kind" varchar(32) NOT NULL,
        "amount" numeric(14,2) NOT NULL DEFAULT 0)`);
      expect((await share('19', '207')).share).toBe(100_000);
      // Konvertatsiya izi — hamma yo'l 503, hech narsa yozilmaydi.
      await db.query(
        `INSERT INTO "${schema}".order_settlement_246_conversion (kind, amount) VALUES ('carry_moved', 30000)`,
      );
      try {
        const closed = { error: { statusCode: 503 } };
        await expect(
          service.getBranchMarketShare({ branch_id: '19', market_id: '207' }),
        ).rejects.toMatchObject(closed);
        await expect(
          service.getBranchMarkets({ branch_id: '19' }),
        ).rejects.toMatchObject(closed);
        await expect(
          service.advanceSettlement({
            level: 'branch_to_market',
            match_value: '19:207',
            amount: 100_000,
            request_id: 'wx1-1',
            requester_id: '15001',
          }),
        ).rejects.toMatchObject(closed);
        const [k1] = await db.query(
          `SELECT market_paid_by_branch_amount::float AS paid, market_paid_by_branch_at AS at
             FROM "${schema}".order_settlement WHERE id = $1`,
          [ids.k1],
        );
        expect(k1).toEqual({ paid: 0, at: null });
        // Token olinmagan — iz tozalangach shu so'rov qo'llanadi.
        const [{ n }] = await db.query(
          `SELECT count(*)::int AS n FROM "${schema}".order_settlement_branch_market_carry
            WHERE branch_id = 19 AND market_id = 207`,
        );
        expect(n).toBe(0);
      } finally {
        await db.query(
          `DROP TABLE "${schema}".order_settlement_246_conversion`,
        );
      }
      await managerPays('19', '207', 100_000, 'wx1-1');
      expect(await markedOf('k1')).toBe(true);
    });

    it('A3: FIFO butun tiyinda — aniq yig`indi (879 621,39) beshala qatorni yopadi, qoldiq 0', async () => {
      const amounts = [241_770.93, 374_981.82, 98_719.71, 71_362.13, 92_786.8];
      for (const [i, amount] of amounts.entries()) {
        await row(`f${i}`, {
          home: '18',
          branch: '18',
          market: '206',
          branchAmount: amount,
          marketAmount: 0,
          status: SettlementStatus.COURIER_SETTLED,
        });
      }
      const res: any = await service.advanceSettlement({
        level: 'branch_to_hq',
        match_value: '18',
        amount: 879_621.39,
        request_id: 'a3-1',
        requester_id: '1',
      });
      expect(res.data.settled_order_ids).toHaveLength(5);
      expect(res.data.leftover).toBe(0);
      for (const i of amounts.keys()) {
        expect(await statusOf(`f${i}`)).not.toBe(
          SettlementStatus.COURIER_SETTLED,
        );
      }
    });
  },
);
