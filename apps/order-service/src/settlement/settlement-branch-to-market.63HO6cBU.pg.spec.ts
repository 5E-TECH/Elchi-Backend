import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IdempotencyKey, SettlementStatus } from '@app/common';
import { OrderSettlementService } from './order-settlement.service';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';
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
    /** b) market: to'langan jami == yopilgan (MARKET_SETTLED yoki belgilangan) Σ + carry. */
    const marketCovered = async (market: string) => {
      const [r] = await db.query(
        `SELECT COALESCE(SUM(market_amount), 0)::float AS s FROM "${schema}".order_settlement
        WHERE market_id = $1 AND is_deleted = false
          AND (status = 'market_settled' OR market_paid_by_branch_at IS NOT NULL)`,
        [market],
      );
      const [c] = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS c FROM "${schema}".order_settlement_carry
        WHERE level = 'hq_to_market' AND party_id = $1`,
        [market],
      );
      return Math.round((Number(r.s) + Number(c.c)) * 100) / 100;
    };
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
      expect(await share(Y, N)).toMatchObject({ in_branch: false, share: 0 });
      const list: any = await service.getBranchMarkets({ branch_id: X });
      expect(list.data.items).toEqual([
        { market_id: M, share: 115_000 },
        { market_id: N, share: 60_000 },
      ]);
      await expectInvariants();
    });

    it('1) qisman to`lov 100 000: r1 belgilanadi, qoldiq 20 000 — branch_to_hq(X) va hq_to_market(M) qoldig`iga; a) Δ payable = −100 000', async () => {
      const before = await payable(X);
      const res: any = await managerPays(X, M, 100_000, 'p-1');
      expect(res.data).toMatchObject({ allocated: 80_000, leftover: 20_000 });
      expect(await markedOf('r1')).toBe(true);
      expect(await markedOf('r2')).toBe(false);
      expect(await markedOf('r7')).toBe(false); // tortilgan kredit yozilmaydi
      expect(await statusOf('r1')).toBe(SettlementStatus.COURIER_SETTLED);
      expect((await payable(X)) - before).toBeCloseTo(-100_000, 2);
      // Boshqa filial / market qatorlari tegilmagan.
      for (const key of ['r3', 'r4', 'r5']) {
        expect(await markedOf(key)).toBe(false);
        expect(await statusOf(key)).toBe(SettlementStatus.COURIER_SETTLED);
      }
      expect(await share(X, M)).toMatchObject({
        in_branch: true,
        share: 35_000,
      });
      await expectInvariants();
    });

    it('2) takroriy token — ikki marta belgilamaydi; parallel ikki nusxa ham bitta', async () => {
      const again: any = await managerPays(X, M, 100_000, 'p-1');
      expect(again.data.replayed).toBe(true);
      await expectInvariants();
    });

    it('3) c) HQ hq_to_market (katta summa) belgilangan va X ning COURIER_SETTLED qatorlarini olmaydi — faqat HQ qatori r6', async () => {
      // HQ M ga qarzi: r6 20 000 − qoldiq 20 000 (filial nomidan to'langan) = 0.
      const res: any = await hqPaysMarket(M, 0.01, 'h-1');
      expect(res.data.settled_order_ids).toHaveLength(1);
      expect(await statusOf('r6')).toBe(SettlementStatus.MARKET_SETTLED);
      for (const key of ['r1', 'r2', 'r4', 'r5', 'r7']) {
        expect(await statusOf(key)).toBe(SettlementStatus.COURIER_SETTLED);
      }
      await expectInvariants();
    });

    it('4) qolgan ulush 35 000 (kredit bilan): r7 va r2 belgilanadi; ulush 0; a) Δ payable = −35 000', async () => {
      const before = await payable(X);
      const res: any = await managerPays(X, M, 35_000, 'p-2');
      expect(res.data).toMatchObject({ allocated: 35_000, leftover: 0 });
      expect(await markedOf('r2')).toBe(true);
      expect(await markedOf('r7')).toBe(true);
      expect((await payable(X)) - before).toBeCloseTo(-35_000, 2);
      expect(await share(X, M)).toMatchObject({ in_branch: true, share: 0 });
      await expectInvariants();
    });

    it('5) Y menejeri o`z ulushini to`laydi — faqat r4 (X qatorlari tegilmaydi)', async () => {
      await managerPays(Y, M, 75_000, 'p-y');
      expect(await markedOf('r4')).toBe(true);
      expect(await markedOf('r5')).toBe(false);
      expect(await payable(Y)).toBeCloseTo(15_000, 2);
      await expectInvariants();
    });

    it('6) d) admin X dan qisman, keyin to`liq oladi: belgilangan qatorlar faqat HQ ulushi bilan, MARKET_SETTLED; qolganlari BRANCH_SETTLED', async () => {
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
      // Kassa: 245 000 − 135 000 = 110 000.
      expect(cash[X]).toBe(110_000);
      await take(10_000, 'b-1'); // + qoldiq 20 000 = 30 000: r1 (HQ ulushi 20 000) + r2 (10 000)
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

    it('7) HQ endi faqat o`z qarzini to`laydi: M — r5 (25 000), N — r3 (60 000); belgilangan qatorlar olinmaydi', async () => {
      await hqPaysMarket(M, 25_000, 'h-2');
      await hqPaysMarket(N, 60_000, 'h-3');
      expect(await statusOf('r5')).toBe(SettlementStatus.MARKET_SETTLED);
      expect(await statusOf('r3')).toBe(SettlementStatus.MARKET_SETTLED);
      // M: X 135 000 + Y 75 000 + HQ 25 000 = Σ market_amount (80+40−5+75+25+20).
      expect(paid[M]).toBe(
        80_000 + 40_000 - 5_000 + 75_000 + 25_000 + 20_000 + 0.01,
      );
      await expectInvariants();
    });

    it('8) T6 retreat: HQ marketga to`lovni qaytarish belgilangan qatorlarni qayta ochmaydi', async () => {
      const before = await statusOf('r1');
      await service.retreatSettlement({
        level: 'hq_to_market',
        match_value: M,
        amount: 25_000,
        request_id: 'rt-1',
        requester_id: '1',
      });
      paid[M] -= 25_000;
      expect(await statusOf('r1')).toBe(before);
      expect(await markedOf('r1')).toBe(true);
      expect(await statusOf('r5')).toBe(SettlementStatus.BRANCH_SETTLED);
      await expectInvariants();
    });

    it('9) parallel ikki bir xil token — bitta belgilash', async () => {
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
      const [{ c }] = await db.query(
        `SELECT COALESCE(SUM(amount),0)::float AS c FROM "${schema}".order_settlement_carry WHERE level = 'branch_to_hq' AND party_id = $1`,
        [X],
      );
      expect(Number(c)).toBe(0);
      await expectInvariants();
    });

    it('10) noto`g`ri tomon / summa → 400', async () => {
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

    it('11) rollback himoyasi: belgilangan qatorli buyurtma qaytarilmaydi (400), daftar o`zgarmaydi', async () => {
      const lifecycle = Object.create(
        OrderLifecycleService.prototype,
      ) as Record<string, any>;
      const r8 = await db
        .getRepository(OrderSettlement)
        .findOneByOrFail({ id: ids.r8 });
      await expect(
        db.transaction((tx) =>
          lifecycle.resetSettlementOnRollback(tx, String(r8.order_id)),
        ),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      const after = await db
        .getRepository(OrderSettlement)
        .findOneByOrFail({ id: ids.r8 });
      expect(after.isDeleted).toBe(false);
      expect(Number(after.market_amount)).toBe(10_000);
    });

    it('12) moliyaviy xulosa: market qarzi belgilangan qatorlarsiz', async () => {
      const summary: any = await service.getFinancialBalanceSettlementSummary();
      const marketsBody = JSON.stringify(summary?.data ?? summary);
      expect(marketsBody).toBeTruthy();
      const [r] = await db.query(
        `SELECT COALESCE(SUM(market_amount) FILTER (WHERE market_paid_by_branch_at IS NULL), 0)::float AS open
         FROM "${schema}".order_settlement
        WHERE market_id = $1 AND is_deleted = false
          AND status IN ('pending','courier_settled','branch_settled')`,
        [N],
      );
      expect(Number(r.open)).toBe(0);
    });
  },
);
