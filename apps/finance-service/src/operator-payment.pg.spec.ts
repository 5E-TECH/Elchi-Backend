import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Cashbox_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';
import {
  OperatorPaymentService,
  tashkentToday,
} from './operator-payment/operator-payment.service';

/**
 * F2qp6FtE (ega qarori 2026-11-16) — market o'z operatoriga O'ZI to'laydi,
 * Elchi Asosiy kassasi o'zgarmaydi; tizim faqat yozuv saqlaydi. HAQIQIY
 * Postgres'da (o'z vaqtinchalik sxemasi, oxirida o'chiriladi):
 *  - yozuv kassa, kassa tarixi, P&L daftariga tegmaydi;
 *  - `Idempotency-Key`: takror — o'sha yozuv, boshqa to'lov bilan — 409,
 *    parallel ayni kalit — bitta qator;
 *  - bekor qilish: sabab majburiy, begona — 404, eski Elchi yozuvi — 409,
 *    takror — 200 (jurnal bir marta), «To'landi» dan chiqadi;
 *  - balans: ishlab topdi − to'landi (eski Elchi to'lovlari ham), manfiy
 *    mumkin;
 *  - DB CHECK: market yozuvi kassaga ta'sir qila olmaydi;
 *  - eski `finance.operator.payment.create` — 410, hech narsa yozmaydi.
 * Env (`FINANCE_OPERATOR_PG_TEST_URI` / `FINANCE_PG_TEST_URI`) bo'lmasa skip.
 */
const pgUri =
  process.env.FINANCE_OPERATOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const MARKET = '12';
const OTHER_MARKET = '99';

describePg(
  'F2qp6FtE — operatorga to`lov yozuvi (kassasiz), haqiqiy Postgres',
  () => {
    const schema = `spec_opay_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let finance: FinanceServiceService;
    let payments: OperatorPaymentService;
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

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
          FinancialBalanceHistory,
          OperatorEarning,
          OperatorPayment,
        ],
        synchronize: true,
        extra: { max: 6 },
      });
      await db.initialize();
      finance = new FinanceServiceService(
        db.getRepository(Cashbox),
        db.getRepository(CashboxHistory),
        {} as never,
        {} as never,
        db.getRepository(OperatorEarning),
        db.getRepository(OperatorPayment),
        db.getRepository(FinancialBalanceHistory),
        db,
        activityLog as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      payments = new OperatorPaymentService(db, activityLog as never);
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      activityLog.log.mockClear();
      await db.query(
        `TRUNCATE TABLE "${schema}".cashbox_history,
        "${schema}".financial_balance_history,
        "${schema}".operator_payments,
        "${schema}".operator_earnings,
        "${schema}".cashboxes RESTART IDENTITY CASCADE`,
      );
      await db.getRepository(Cashbox).save(
        db.getRepository(Cashbox).create({
          user_id: '0',
          cashbox_type: Cashbox_type.MAIN,
          balance: 10000,
          balance_cash: 10000,
          balance_card: 0,
        }),
      );
      const earnings = db.getRepository(OperatorEarning);
      await earnings.save([
        earnings.create({
          operator_id: '42',
          order_id: '7001',
          market_id: MARKET,
          amount: 15000,
        }),
        earnings.create({
          operator_id: '42',
          order_id: '7002',
          market_id: MARKET,
          amount: 5000,
        }),
        earnings.create({
          operator_id: '43',
          order_id: '7003',
          market_id: MARKET,
          amount: 3000,
        }),
      ]);
    });

    const base = (extra: Record<string, unknown> = {}) => ({
      market_id: MARKET,
      operator_id: '42',
      amount: 5000,
      recorded_by_id: MARKET,
      recorded_by_role: 'market',
      idempotency_key: `k-${randomUUID()}`,
      ...extra,
    });

    /** Kassa, kassa tarixi va P&L daftari — boshlang'ich holatda. */
    const expectCashUntouched = async () => {
      expect(await db.getRepository(CashboxHistory).count()).toBe(0);
      expect(await db.getRepository(FinancialBalanceHistory).count()).toBe(0);
      const main = await db.getRepository(Cashbox).findOneByOrFail({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
      });
      expect(Number(main.balance)).toBe(10000);
      expect(Number(main.balance_cash)).toBe(10000);
    };

    const insertLegacy = (extra: Partial<OperatorPayment> = {}) =>
      db.getRepository(OperatorPayment).save(
        db.getRepository(OperatorPayment).create({
          operator_id: '42',
          market_id: null,
          paid_by_id: '1',
          amount: 2000,
          note: 'Eski',
          source: 'elchi',
          affects_cashbox: true,
          paid_at: '2026-10-01',
          ...extra,
        }),
      );

    it('yozuv: 201, market manbasi, kassasiz — kassa, tarix va daftar o`zgarmaydi', async () => {
      const res: any = await payments.record(
        base({ paid_at: '2026-11-01', note: '  Oktabr  ' }),
      );

      expect(res.statusCode).toBe(201);
      expect(res.data).toMatchObject({
        operator_id: '42',
        market_id: MARKET,
        amount: 5000,
        paid_at: '2026-11-01',
        note: 'Oktabr',
        source: 'market',
        affects_cashbox: false,
        recorded_by_role: 'market',
        status: 'active',
        can_cancel: true,
        idempotent: false,
      });
      expect(res.data).not.toHaveProperty('idempotency_key');
      const row = await db.getRepository(OperatorPayment).findOneByOrFail({
        id: res.data.id,
      });
      expect(row).toMatchObject({
        paid_by_id: MARKET,
        source: 'market',
        affects_cashbox: false,
      });
      await expectCashUntouched();
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'OperatorPayment',
          action: 'finance.operator_payment_recorded',
          user_id: MARKET,
          user_role: 'market',
        }),
      );
    });

    it('sana berilmasa — bugungi Toshkent kuni; kelajak, yaroqsiz sana, 0, 3 kasr, kalitsiz — 400 va yozuvsiz', async () => {
      const res: any = await payments.record(base());
      expect(res.data.paid_at).toBe(tashkentToday());

      const bad = [
        base({ paid_at: '2999-01-01' }),
        base({ paid_at: '2026-02-30' }),
        base({ paid_at: '18.11.2026' }),
        base({ amount: 0 }),
        base({ amount: -5 }),
        base({ amount: 1.005 }),
        base({ idempotency_key: '  ' }),
        base({ note: 'x'.repeat(501) }),
        base({ operator_id: 'abc' }),
      ];
      for (const input of bad) {
        await expect(payments.record(input)).rejects.toMatchObject({
          error: { statusCode: 400 },
        });
      }
      expect(await db.getRepository(OperatorPayment).count()).toBe(1);
      await expectCashUntouched();
    });

    it('ayni Idempotency-Key: takror — o`sha yozuv (200), boshqa summa — 409; parallel — bitta qator', async () => {
      const first: any = await payments.record(
        base({ idempotency_key: 'k-1' }),
      );
      const again: any = await payments.record(
        base({ idempotency_key: 'k-1' }),
      );
      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(200);
      expect(again.data).toMatchObject({ id: first.data.id, idempotent: true });

      await expect(
        payments.record(base({ idempotency_key: 'k-1', amount: 6000 })),
      ).rejects.toMatchObject({ error: { statusCode: 409 } });

      // Boshqa market ayni kalit bilan — o'zining alohida yozuvi (kalit ko'lami
      // — market).
      const otherMarket: any = await payments.record(
        base({ idempotency_key: 'k-1', market_id: OTHER_MARKET }),
      );
      expect(otherMarket.statusCode).toBe(201);

      const results = await Promise.allSettled([
        payments.record(base({ idempotency_key: 'k-par' })),
        payments.record(base({ idempotency_key: 'k-par' })),
        payments.record(base({ idempotency_key: 'k-par' })),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const ids = new Set(
        results.map((r) => (r as PromiseFulfilledResult<any>).value.data.id),
      );
      expect(ids.size).toBe(1);
      expect(
        await db
          .getRepository(OperatorPayment)
          .countBy({ idempotency_key: 'k-par' }),
      ).toBe(1);
      expect(activityLog.log).toHaveBeenCalledTimes(3);
      await expectCashUntouched();
    });

    it('qoldiqdan ortiq to`lov ham yoziladi — balans manfiy (ortiqcha to`langan)', async () => {
      await payments.record(base({ amount: 25000 }));

      const own: any = await finance.findOperatorBalance({ operator_id: '42' });
      expect(own.data).toEqual({
        operator_id: '42',
        earned: 20000,
        paid: 25000,
        balance: -5000,
      });
      const all: any = await payments.balances({
        operator_ids: ['42', '43', '44'],
      });
      expect(all.data.items).toEqual([
        expect.objectContaining({
          operator_id: '42',
          earned: 20000,
          paid: 25000,
          balance: -5000,
          payments_count: 1,
        }),
        expect.objectContaining({
          operator_id: '43',
          earned: 3000,
          paid: 0,
          balance: 3000,
          last_paid_at: null,
        }),
        expect.objectContaining({
          operator_id: '44',
          earned: 0,
          paid: 0,
          balance: 0,
        }),
      ]);
      expect(all.data.totals).toEqual({
        earned: 23000,
        paid: 25000,
        balance: -2000,
      });
    });

    it('bekor qilish: sabab majburiy, begona — 404, takror — 200 (jurnal bir marta), «To`landi» dan chiqadi', async () => {
      const created: any = await payments.record(base({ amount: 7000 }));
      const id = created.data.id;

      await expect(
        payments.cancel({
          market_id: MARKET,
          payment_id: id,
          reason: '  ',
          cancelled_by_id: MARKET,
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      await expect(
        payments.cancel({
          market_id: OTHER_MARKET,
          payment_id: id,
          reason: 'Xato summa',
          cancelled_by_id: OTHER_MARKET,
        }),
      ).rejects.toMatchObject({ error: { statusCode: 404 } });
      await expect(
        payments.cancel({
          market_id: MARKET,
          payment_id: '999999',
          reason: 'Xato summa',
          cancelled_by_id: MARKET,
        }),
      ).rejects.toMatchObject({ error: { statusCode: 404 } });

      activityLog.log.mockClear();
      const cancelled: any = await payments.cancel({
        market_id: MARKET,
        payment_id: id,
        reason: ' Xato summa ',
        cancelled_by_id: MARKET,
        cancelled_by_role: 'market',
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.data).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'Xato summa',
        cancelled_by_role: 'market',
        can_cancel: false,
        idempotent: false,
      });
      const again: any = await payments.cancel({
        market_id: MARKET,
        payment_id: id,
        reason: 'Boshqa sabab',
        cancelled_by_id: MARKET,
      });
      expect(again.data).toMatchObject({
        idempotent: true,
        cancel_reason: 'Xato summa',
      });
      expect(activityLog.log).toHaveBeenCalledTimes(1);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'finance.operator_payment_cancelled',
        }),
      );

      const balance: any = await finance.findOperatorBalance({
        operator_id: '42',
      });
      expect(balance.data).toMatchObject({
        earned: 20000,
        paid: 0,
        balance: 20000,
      });
      // Qator qoladi va ro'yxatlarda ko'rinadi.
      const list: any = await payments.list({
        market_id: MARKET,
        operator_ids: ['42'],
      });
      expect(list.data.items).toEqual([
        expect.objectContaining({ id, status: 'cancelled', can_cancel: false }),
      ]);
      const me: any = await finance.listOperatorPayments({ operator_id: '42' });
      expect(me.data.rows[0]).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'Xato summa',
      });
      expect(me.data.rows[0]).not.toHaveProperty('idempotency_key');
      await expectCashUntouched();
    });

    it('eski Elchi yozuvi: «To`landi» ga kiradi, market tarixida ko`rinadi, lekin bekor qilinmaydi (409)', async () => {
      const legacy = await insertLegacy();
      await payments.record(base({ amount: 1000, paid_at: '2026-11-02' }));
      // Boshqa market yozgan yozuv bu marketga ko'rinmaydi.
      await payments.record(base({ market_id: OTHER_MARKET, amount: 300 }));

      const list: any = await payments.list({
        market_id: MARKET,
        operator_ids: ['42', '43'],
      });
      expect(list.data.pagination).toMatchObject({
        total: 2,
        page: 1,
        limit: 20,
      });
      expect(
        list.data.items.map((item: any) => [
          item.source,
          item.amount,
          item.can_cancel,
        ]),
      ).toEqual([
        ['market', 1000, true],
        ['elchi', 2000, false],
      ]);
      expect(list.data.items[1]).toMatchObject({
        affects_cashbox: true,
        market_id: null,
      });

      await expect(
        payments.cancel({
          market_id: MARKET,
          payment_id: String(legacy.id),
          reason: 'Xato',
          cancelled_by_id: MARKET,
        }),
      ).rejects.toMatchObject({ error: { statusCode: 404 } });
      await db
        .getRepository(OperatorPayment)
        .update({ id: legacy.id }, { market_id: MARKET });
      await expect(
        payments.cancel({
          market_id: MARKET,
          payment_id: String(legacy.id),
          reason: 'Xato',
          cancelled_by_id: MARKET,
        }),
      ).rejects.toMatchObject({ error: { statusCode: 409 } });

      // Operator filtri va sahifalash.
      const page2: any = await payments.list({
        market_id: MARKET,
        operator_ids: ['42'],
        operator_id: '42',
        page: 2,
        limit: 1,
      });
      expect(page2.data.items).toHaveLength(1);
      expect(page2.data.pagination).toMatchObject({
        total: 2,
        page: 2,
        limit: 1,
        totalPages: 2,
      });

      const balance: any = await finance.findOperatorBalance({
        operator_id: '42',
      });
      // 20 000 − (eski 2 000 + market 1 000 + boshqa market 300).
      expect(balance.data).toMatchObject({ paid: 3300, balance: 16700 });
    });

    it('DB CHECK: market yozuvi kassaga ta`sir qila olmaydi; eski yozuvni bekor qilib bo`lmaydi', async () => {
      const repo = db.getRepository(OperatorPayment);
      await expect(
        repo.save(
          repo.create({
            operator_id: '42',
            market_id: MARKET,
            amount: 100,
            source: 'market',
            affects_cashbox: true,
          }),
        ),
      ).rejects.toThrow(/CHK_OPERATOR_PAYMENT_MARKET_NO_CASHBOX/);
      const legacy = await insertLegacy();
      await expect(
        repo.update(
          { id: legacy.id },
          { cancelled_at: new Date(), cancel_reason: 'x' },
        ),
      ).rejects.toThrow(/CHK_OPERATOR_PAYMENT_CANCEL/);
    });

    it('eski `finance.operator.payment.create` — 410, hech narsa yozilmaydi', async () => {
      await expect(finance.createOperatorPayment()).rejects.toMatchObject({
        error: { statusCode: 410 },
      });
      expect(await db.getRepository(OperatorPayment).count()).toBe(0);
      await expectCashUntouched();
    });
  },
);
