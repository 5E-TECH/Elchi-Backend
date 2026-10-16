/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  IdempotencyKey,
  Order_status,
  OutboxEvent,
  OutboxService,
} from '@app/common';
import { Order, OrderReplacementState } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';
import { OrderLifecycleService } from './order-lifecycle.service';
import {
  findReplaceableOrders,
  findReplacementReturns,
} from './order-replacement';
import { OrderReplacement1716000000111 } from '../../../../migrations/1716000000111-OrderReplacement';

/**
 * lQjt6sKP — ALMASHTIRISH (kafolat-swap) HAQIQIY Postgres'da.
 *
 * Kartadagi TC'lar:
 *   TC1 yetkazilgan buyurtmani almashtirishga tanlash mumkin;
 *   TC2 yangi (status=new) buyurtma → 400;
 *   TC3 boshqa marketning buyurtmasi → 400;
 *   TC4 bitta buyurtmani ikki marta (ketma-ket va PARALLEL) → 400, DB
 *       darajasida ham `UQ_ORDER_REPLACEMENT_OF`;
 *   TC5 eski buyurtmaning pul yozuvlari o'zgarmaydi (ustunlar, outbox,
 *       settlement);
 *   TC6 kuryer "eskisini oldim" tasdiqlamaguncha sotuv (to'liq va qisman)
 *       to'siladi — hech bir kassa oyog'i yozilmaydi.
 * + migratsiya 111 up/down (idempotent) va ro'yxatlar (replaceable, returns).
 *
 * Faqat lokal test bazasi (ORDER_REPLACEMENT_PG_TEST_URI,
 * .../elchi_o1_replacement_test) berilsa ishlaydi.
 */
const uri = process.env.ORDER_REPLACEMENT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_o1_replacement_test'
  );
})();

type Row = Record<string, any>;

const MARKET_ID = '501';
const OTHER_MARKET_ID = '502';
const COURIER_ID = '301';
const COURIER = { id: COURIER_ID, roles: ['courier'], branch_id: null };
const MARKET = { id: MARKET_ID, roles: ['market'] };

/** Eski buyurtmaning PUL va holat ustunlari (TC5 solishtiruvi). */
const MONEY_COLUMNS = `status, total_price, to_be_paid, paid_amount,
  paid_online_amount, market_tariff, courier_tariff, courier_share,
  branch_share, branch_cashbox_amount, sale_collectible_amount,
  sale_market_paid_amount, extra_cost, sold_at, market_id, customer_id,
  courier_id, post_id, holder_type, holder_courier_id`;

(localTestDatabase ? describe : describe.skip)(
  'lQjt6sKP — almashtirish (kafolat-swap) haqiqiy Postgres (pg)',
  () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
    const orderSchema = `spec_repl_${suffix}`;
    let admin: DataSource;
    let orderDb: DataSource;
    let lifecycle: OrderLifecycleService;

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${orderSchema}"`);
      await admin.query('CREATE SCHEMA IF NOT EXISTS "branch_schema"');

      orderDb = new DataSource({
        type: 'postgres',
        url: uri,
        schema: orderSchema,
        entities: [
          Order,
          OrderItem,
          OrderTracking,
          OrderCustodyEvent,
          Branch,
          OrderSettlement,
          OrderSettlementCarry,
          OutboxEvent,
          IdempotencyKey,
        ],
        synchronize: true,
      });
      await orderDb.initialize();

      const lookup = {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        getMarketsByIds: jest.fn().mockResolvedValue([
          {
            id: MARKET_ID,
            tariff_center: 45000,
            tariff_home: 70000,
            expense_proof_conditions: [],
          },
        ]),
        getCouriersByIds: jest.fn((ids: string[]) =>
          Promise.resolve(
            ids.map((id) => ({
              id,
              tariff_center: 30000,
              tariff_home: 50000,
              can_add_extra_cost: true,
              can_sell_cancel: true,
            })),
          ),
        ),
        getUserById: jest.fn().mockResolvedValue(null),
        getCashboxByUser: jest.fn(
          (userId: string, cashbox_type: Cashbox_type) =>
            Promise.resolve({
              id: `${cashbox_type}-${userId}`,
              user_id: userId,
              cashbox_type,
              balance: 0,
            }),
        ),
        ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
        resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
        resolveBranchShare: jest.fn().mockResolvedValue(0),
      };

      const instance = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService & Row;
      Object.assign(instance, {
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
        dataSource: orderDb,
        orderRepo: orderDb.getRepository(Order),
        orderItemRepo: orderDb.getRepository(OrderItem),
        orderSettlementRepo: orderDb.getRepository(OrderSettlement),
        outbox: new OutboxService(orderDb.getRepository(OutboxEvent)),
        lookup,
        logisticsClient: {
          send: jest.fn(() =>
            of({ data: { id: '9001', courier_id: COURIER_ID } }),
          ),
        },
        custody: {
          createTrackingEvent: jest.fn(),
          createCustodyEvent: jest.fn(),
          toTrackingRole: jest.fn(() => 'courier'),
          auditActor: jest.fn(() => ({})),
        },
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
        syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
        enqueueFinanceOnStatusChange: jest.fn().mockResolvedValue(undefined),
        queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
        enforceOperationProof: jest.fn().mockResolvedValue([]),
        requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
        // Yaratishda filial/egalik — HQ (filial-service'siz).
        resolveBranchIdForOrder: jest.fn().mockResolvedValue('1'),
      });
      lifecycle = instance;
    }, 60_000);

    afterAll(async () => {
      if (orderDb?.isInitialized) await orderDb.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${orderSchema}" CASCADE`);
        await admin.query('DROP SCHEMA IF EXISTS "branch_schema" CASCADE');
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      await orderDb.query(
        `TRUNCATE "${orderSchema}".orders, "${orderSchema}".order_items,
          "${orderSchema}".order_settlement, "${orderSchema}".outbox_events,
          "${orderSchema}".idempotency_keys RESTART IDENTITY CASCADE`,
      );
    });

    /** Yetkazilgan (yoki berilgan holatdagi) eski buyurtma, pul ustunlari bilan. */
    const addOrder = async (
      id: string,
      opts: { status?: string; market?: string; customer?: string } = {},
    ) => {
      await orderDb.query(
        `INSERT INTO "${orderSchema}".orders
          (id, market_id, customer_id, status, source, total_price,
           to_be_paid, paid_amount, where_deliver, holder_type,
           holder_courier_id, courier_id, post_id, market_tariff,
           courier_tariff, courier_share, branch_share,
           sale_collectible_amount, sold_at, comment)
         VALUES ($1, $2, $3, $4, 'internal', 150000, 105000, 0, 'center',
                 'COURIER', $5, $5, 9001, 45000, 30000, 30000, 0, 150000,
                 1760090400000, 'kafolatli telefon')`,
        [
          id,
          opts.market ?? MARKET_ID,
          opts.customer ?? '801',
          opts.status ?? 'sold',
          COURIER_ID,
        ],
      );
      await orderDb.query(
        `INSERT INTO "${orderSchema}".order_items
           (order_id, product_id, product_name, quantity)
         VALUES ($1, 7, 'Samsung A15', 1)`,
        [id],
      );
    };

    const createReplacement = (replacedOrderId: unknown, market = MARKET_ID) =>
      lifecycle.create(
        {
          market_id: market,
          customer_id: '801',
          total_price: 150000,
          where_deliver: 'center' as never,
          items: [
            { product_id: '7', product_name: 'Samsung A15', quantity: 1 },
          ],
          replaced_order_id: replacedOrderId as string,
        },
        MARKET,
      );

    const orderRow = async (id: string) =>
      (
        await orderDb.query(
          `SELECT id::text, status, replacement_of_order_id::text,
                  replacement_state::text, is_replacement_return,
                  old_item_collected_at
           FROM "${orderSchema}".orders WHERE id = $1`,
          [id],
        )
      )[0] as Row;

    const moneySnapshot = async (id: string) =>
      (
        await orderDb.query(
          `SELECT ${MONEY_COLUMNS} FROM "${orderSchema}".orders WHERE id = $1`,
          [id],
        )
      )[0] as Row;

    const count = async (table: string, where = 'true') =>
      Number(
        (
          await orderDb.query(
            `SELECT count(*)::int AS n FROM "${orderSchema}".${table} WHERE ${where}`,
          )
        )[0].n,
      );

    const expectRpc400 = async (promise: Promise<unknown>, pattern: RegExp) => {
      const error = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).not.toBeNull();
      const payload = (error as { getError?: () => unknown }).getError?.() as
        | { statusCode?: number; message?: string }
        | undefined;
      expect(payload?.statusCode).toBe(400);
      expect(String(payload?.message)).toMatch(pattern);
    };

    it("TC1: yetkazilgan buyurtma almashtirishga tanlanadi — yangisi bog'lanadi, eskisi qaytarishga belgilanadi", async () => {
      await addOrder('101');
      const created = (await createReplacement('101')) as Row;

      const fresh = await orderRow(String(created.id));
      expect(fresh).toMatchObject({
        status: Order_status.NEW,
        replacement_of_order_id: '101',
        replacement_state: OrderReplacementState.AWAITING_OLD_PICKUP,
        is_replacement_return: false,
      });
      expect(await orderRow('101')).toMatchObject({
        status: 'sold',
        replacement_of_order_id: null,
        replacement_state: OrderReplacementState.AWAITING_OLD_PICKUP,
        is_replacement_return: true,
      });
    });

    it.each([['paid'], ['partly_paid']])(
      'TC1: %s holatidagi buyurtma ham yetkazilgan hisoblanadi',
      async (status) => {
        await addOrder('102', { status });
        await createReplacement('102');
        expect((await orderRow('102')).is_replacement_return).toBe(true);
      },
    );

    it.each([['new'], ['waiting'], ['cancelled'], ['closed']])(
      "TC2: %s holatidagi buyurtmani tanlab bo'lmaydi → 400, hech narsa yaratilmaydi",
      async (status) => {
        await addOrder('103', { status });
        await expectRpc400(createReplacement('103'), /yetkazib berilgan/);
        expect(await count('orders')).toBe(1);
        expect((await orderRow('103')).is_replacement_return).toBe(false);
      },
    );

    it("TC3: boshqa marketning buyurtmasi → 400 (borligi ham oshkor bo'lmaydi)", async () => {
      await addOrder('104', { market: OTHER_MARKET_ID });
      await expectRpc400(createReplacement('104'), /shu marketda topilmadi/);
      // Mavjud bo'lmagan buyurtma bilan AYNI xabar.
      await expectRpc400(createReplacement('999999'), /shu marketda topilmadi/);
      expect(await count('orders')).toBe(1);
      expect((await orderRow('104')).is_replacement_return).toBe(false);
    });

    it('TC4: bir buyurtmani ikki marta belgilash → 400', async () => {
      await addOrder('105');
      const first = (await createReplacement('105')) as Row;
      await expectRpc400(createReplacement('105'), /allaqachon almashtirishga/);
      expect(await count('orders', 'replacement_of_order_id = 105')).toBe(1);
      expect((await orderRow(String(first.id))).replacement_of_order_id).toBe(
        '105',
      );
    });

    it("TC4: PARALLEL ikki yaratish — bittasi o'tadi, ikkinchisi 400 (FOR UPDATE qulfi)", async () => {
      await addOrder('106');
      const results = await Promise.allSettled([
        createReplacement('106'),
        createReplacement('106'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      const payload = (
        rejected?.reason as { getError?: () => unknown }
      )?.getError?.() as { statusCode?: number } | undefined;
      expect(payload?.statusCode).toBe(400);
      expect(await count('orders', 'replacement_of_order_id = 106')).toBe(1);
    });

    it("TC4: DB darajasi — ikkinchi faol almashtirish UQ_ORDER_REPLACEMENT_OF bilan rad etiladi; o'chirilgani hisobga olinmaydi", async () => {
      await addOrder('107');
      await createReplacement('107');
      const insert = () =>
        orderDb.query(
          `INSERT INTO "${orderSchema}".orders
             (market_id, customer_id, status, source, total_price,
              where_deliver, holder_type, replacement_of_order_id)
           VALUES ($1, 801, 'new', 'internal', 1, 'center', 'HQ', 107)`,
          [MARKET_ID],
        );
      await expect(insert()).rejects.toMatchObject({
        driverError: { code: '23505' },
      });
      // Market xato yaratganini o'chirsa — eski buyurtma qayta tanlanadi.
      await orderDb.query(
        `UPDATE "${orderSchema}".orders SET is_deleted = true
         WHERE replacement_of_order_id = 107`,
      );
      await expect(createReplacement('107')).resolves.toBeDefined();
    });

    it("TC5: almashtirishda eski buyurtmaning pul yozuvlari o'zgarmaydi", async () => {
      await addOrder('108');
      const before = await moneySnapshot('108');
      const outboxBefore = await count('outbox_events');
      const settlementBefore = await count('order_settlement');

      await createReplacement('108');

      expect(await moneySnapshot('108')).toEqual(before);
      // Hech qanday kassa / moliya hodisasi (reversal yo'q).
      expect(
        await count(
          'outbox_events',
          `pattern LIKE 'finance.%' AND id > ${outboxBefore}`,
        ),
      ).toBe(0);
      expect(await count('order_settlement')).toBe(settlementBefore);
    });

    it("replaced_order_id shakli noto'g'ri → 400; bo'sh — oddiy buyurtma", async () => {
      await expectRpc400(createReplacement('abc'), /replaced_order_id/);
      await expectRpc400(createReplacement('0'), /replaced_order_id/);
      const plain = (await createReplacement('')) as Row;
      expect((await orderRow(String(plain.id))).replacement_of_order_id).toBe(
        null,
      );
    });

    it('tashqi buyurtmada replaced_order_id → 400', async () => {
      await addOrder('109');
      await expectRpc400(
        lifecycle.createExternalOrder(
          {
            market_id: MARKET_ID,
            customer_id: '801',
            replaced_order_id: '109',
          } as never,
          { id: '1', roles: ['superadmin'] },
        ),
        /tashqi buyurtmada/,
      );
    });

    describe('TC6: sotish darvozasi — "eskisini oldim" tasdig\'isiz sotib bo\'lmaydi', () => {
      /** Almashtirish buyurtmasini kuryerga, WAITING holatiga o'tkazish. */
      const prepareWaitingReplacement = async (oldId: string) => {
        await addOrder(oldId);
        const created = (await createReplacement(oldId)) as Row;
        const id = String(created.id);
        await orderDb.query(
          `UPDATE "${orderSchema}".orders
             SET status = 'waiting', post_id = 9001, courier_id = $2,
                 holder_type = 'COURIER', holder_courier_id = $2
           WHERE id = $1`,
          [id, COURIER_ID],
        );
        return id;
      };

      it("to'liq sotuv: tasdiqsiz → 400, hech bir kassa oyog'i yozilmaydi, holat o'zgarmaydi", async () => {
        const id = await prepareWaitingReplacement('110');
        const outboxBefore = await count('outbox_events');

        await expectRpc400(
          lifecycle.sellOrder(COURIER, id, {}),
          /eski mahsulotni mijozdan olganingizni tasdiqlang/,
        );
        await expectRpc400(
          lifecycle.sellOrder(COURIER, id, { oldItemCollected: 'false' }),
          /tasdiqlang/,
        );

        expect((await orderRow(id)).status).toBe('waiting');
        expect(await count('outbox_events')).toBe(outboxBefore);
        expect(await count('order_settlement')).toBe(0);
        expect((await orderRow('110')).replacement_state).toBe(
          OrderReplacementState.AWAITING_OLD_PICKUP,
        );
      });

      it("to'liq sotuv: oldItemCollected=true → sotiladi, ikkala buyurtmada old_collected; eski pul o'zgarmaydi", async () => {
        const id = await prepareWaitingReplacement('111');
        const oldMoney = await moneySnapshot('111');

        await lifecycle.sellOrder(COURIER, id, { oldItemCollected: true });

        const fresh = await orderRow(id);
        expect(fresh.status).toBe('sold');
        expect(fresh.replacement_state).toBe(
          OrderReplacementState.OLD_COLLECTED,
        );
        expect(fresh.old_item_collected_at).not.toBeNull();
        const old = await orderRow('111');
        expect(old.replacement_state).toBe(OrderReplacementState.OLD_COLLECTED);
        expect(old.old_item_collected_at).not.toBeNull();
        expect(await moneySnapshot('111')).toEqual(oldMoney);
        // Yangi buyurtmaning o'z sotuv settlement'i (oddiy sotuv yo'li).
        expect(await count('order_settlement', `order_id = ${id}`)).toBe(1);
      });

      it('multipart: oldItemCollected="true" satri ham qabul qilinadi', async () => {
        const id = await prepareWaitingReplacement('112');
        await lifecycle.sellOrder(COURIER, id, { oldItemCollected: 'true' });
        expect((await orderRow(id)).status).toBe('sold');
      });

      it("qisman sotuv ham AYNI darvozadan o'tadi — tasdiqsiz 400", async () => {
        const id = await prepareWaitingReplacement('113');
        const itemId = String(
          (
            await orderDb.query(
              `SELECT id::text FROM "${orderSchema}".order_items
               WHERE order_id = $1 LIMIT 1`,
              [id],
            )
          )[0].id,
        );
        await expectRpc400(
          lifecycle.partlySellOrder(COURIER, id, {
            order_item_info: [{ product_id: itemId, quantity: 1 }] as never,
            totalPrice: 100000,
          }),
          /tasdiqlang/,
        );
        expect((await orderRow(id)).status).toBe('waiting');
        expect(await count('order_settlement')).toBe(0);
      });

      it("oddiy (almashtirish bo'lmagan) buyurtma darvozaga tushmaydi", async () => {
        await addOrder('114', { status: 'waiting' });
        await lifecycle.sellOrder(COURIER, '114', {});
        expect((await orderRow('114')).status).toBe('sold');
      });
    });

    describe("ro'yxatlar", () => {
      it('replaceable: faqat shu market, yetkazilgan va hali almashtirilmagan; q va customer_ids', async () => {
        await addOrder('120');
        await addOrder('121', { status: 'new' });
        await addOrder('122', { market: OTHER_MARKET_ID });
        await addOrder('123', { customer: '802' });
        await addOrder('124');
        await createReplacement('124');

        const all = await findReplaceableOrders(orderDb.manager, {
          market_id: MARKET_ID,
        });
        expect(all.items.map((o) => o.id).sort()).toEqual(['120', '123']);
        expect(all.items[0].items[0]).toMatchObject({
          product_name: 'Samsung A15',
          quantity: 1,
        });

        const byId = await findReplaceableOrders(orderDb.manager, {
          market_id: MARKET_ID,
          q: '123',
        });
        expect(byId.items.map((o) => o.id)).toEqual(['123']);

        const byText = await findReplaceableOrders(orderDb.manager, {
          market_id: MARKET_ID,
          q: 'samsung',
        });
        expect(byText.total).toBe(2);

        const byCustomers = await findReplaceableOrders(orderDb.manager, {
          market_id: MARKET_ID,
          customer_ids: ['802'],
        });
        expect(byCustomers.items.map((o) => o.id)).toEqual(['123']);

        const none = await findReplaceableOrders(orderDb.manager, {
          market_id: MARKET_ID,
          customer_ids: [],
        });
        expect(none.total).toBe(0);
      });

      it('replaceable: market_id majburiy', async () => {
        await expect(
          findReplaceableOrders(orderDb.manager, {}),
        ).rejects.toBeDefined();
      });

      it("returns: eski buyurtma + uning o'rniga ketgan yangisi, holat filtri", async () => {
        await addOrder('130');
        const created = (await createReplacement('130')) as Row;
        await addOrder('131', { market: OTHER_MARKET_ID });

        const res = await findReplacementReturns(orderDb.manager, {
          market_id: MARKET_ID,
        });
        expect(res.total).toBe(1);
        expect(res.items[0]).toMatchObject({
          id: '130',
          replacement_state: OrderReplacementState.AWAITING_OLD_PICKUP,
          replacement_order_id: String(created.id),
          replacement_order_status: Order_status.NEW,
        });

        const collected = await findReplacementReturns(orderDb.manager, {
          market_id: MARKET_ID,
          state: OrderReplacementState.OLD_COLLECTED,
        });
        expect(collected.total).toBe(0);
      });
    });

    describe('migratsiya 1716000000111', () => {
      const migrationDb = `order_schema`;
      let ownsSchema = false;

      beforeAll(async () => {
        const exists = await admin.query(
          `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
          [migrationDb],
        );
        ownsSchema = exists.length === 0;
        if (!ownsSchema) return;
        await admin.query(`CREATE SCHEMA "${migrationDb}"`);
        await admin.query(
          `CREATE TABLE "${migrationDb}"."orders"
             (id bigserial PRIMARY KEY, is_deleted boolean NOT NULL DEFAULT false)`,
        );
        await admin.query(
          `INSERT INTO "${migrationDb}"."orders" (is_deleted) VALUES (false), (true)`,
        );
      });

      afterAll(async () => {
        if (ownsSchema) {
          await admin.query(`DROP SCHEMA IF EXISTS "${migrationDb}" CASCADE`);
        }
      });

      it('up ikki marta (idempotent), mavjud qatorlar buzilmaydi; down/up ishlaydi', async () => {
        if (!ownsSchema) return; // umumiy bazaga tegilmaydi
        const runner = admin.createQueryRunner();
        const migration = new OrderReplacement1716000000111();
        try {
          await migration.up(runner);
          await migration.up(runner);
          const rows: Row[] = await admin.query(
            `SELECT is_replacement_return, replacement_state,
                    replacement_of_order_id
             FROM "${migrationDb}"."orders" ORDER BY id`,
          );
          expect(rows).toEqual([
            {
              is_replacement_return: false,
              replacement_state: null,
              replacement_of_order_id: null,
            },
            {
              is_replacement_return: false,
              replacement_state: null,
              replacement_of_order_id: null,
            },
          ]);
          const idx: Row[] = await admin.query(
            `SELECT indexname FROM pg_indexes WHERE schemaname = $1
             ORDER BY indexname`,
            [migrationDb],
          );
          expect(idx.map((r) => r.indexname)).toEqual(
            expect.arrayContaining([
              'IDX_ORDER_REPLACEMENT_RETURN',
              'UQ_ORDER_REPLACEMENT_OF',
            ]),
          );
          await migration.down(runner);
          const cols: Row[] = await admin.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = 'orders'`,
            [migrationDb],
          );
          expect(cols.map((c) => c.column_name).sort()).toEqual([
            'id',
            'is_deleted',
          ]);
          await migration.up(runner);
        } finally {
          await runner.release();
        }
      });
    });
  },
);
