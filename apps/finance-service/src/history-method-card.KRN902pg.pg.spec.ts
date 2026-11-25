import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { FinanceDailyService } from './aggregates/finance-daily.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { CashboxReceipt } from './entities/cashbox-receipt.entity';
import { FinanceCashboxDaily } from './entities/finance-cashbox-daily.entity';
import { FinanceDailySnapshot } from './entities/finance-daily-snapshot.entity';
import { FinanceSetting } from './entities/finance-setting.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { PaymentCorrection } from './entities/payment-correction.entity';
import { Shift } from './entities/shift.entity';
import { ShiftScheduleClaim } from './entities/shift-schedule-claim.entity';

/**
 * KRN902pg — kassa tarixida «To'lov usuli» (`payment_method`) va «Karta»
 * (`card_id`) filtrlari, haqiqiy Postgres (`FINANCE_PG_TEST_URI`):
 *
 *  • `payment_method=cash` / `cash,click` / `none`; `counts` va
 *    `pagination.total` filtrdan keyin; boshqa filtrlar bilan AND;
 *  • `card_id=<nomli>` / `<Asosiy karta>` (kartasiz `click` qatorlari) /
 *    `none`; kuryer va market kassasi qatori — o'tkazmaning asosiy kassa
 *    qatoridagi karta; filial kassasida karta yo'q (63HO6cBU);
 *  • chek holati filtri bilan birga (`id` ustunida `And`);
 *  • noma'lum qiymat → 400;
 *  • `GET /finance/cashbox/user/:id` tarixi va `history/daily` — AYNI ma'no.
 */
const pgUri =
  process.env.FINANCE_OPERATOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const COURIER = '301';
const MARKET = '201';
const BRANCH = '15';

const errorBody = async (promise: Promise<unknown>): Promise<any> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof RpcException) return error.getError();
    const withBody = error as { getError?: () => unknown };
    return typeof withBody?.getError === 'function'
      ? withBody.getError()
      : error;
  }
  throw new Error('xato kutilgan edi');
};

describePg(
  'KRN902pg — tarix: «To`lov usuli» va «Karta» filtri (Postgres)',
  () => {
    const schema = `spec_krn902_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let service: FinanceServiceService;
    let daily: FinanceDailyService;
    const ids: Record<string, string> = {};
    const box: Record<string, string> = {};
    let defaultCardId = '';
    let namedCardId = '';
    let archivedCardId = '';

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
          CashboxCardMovement,
          CashboxReceipt,
          FinanceCashboxDaily,
          FinanceDailySnapshot,
          FinancialBalanceHistory,
          FinanceSetting,
          PaymentCorrection,
          Shift,
          ShiftScheduleClaim,
        ],
        synchronize: true,
      });
      await db.initialize();
      const identityClient = {
        send: jest.fn((_pattern: unknown, payload: any) =>
          of({ data: { id: payload?.id, name: 'Xodim' } }),
        ),
      };
      service = new FinanceServiceService(
        db.getRepository(Cashbox),
        db.getRepository(CashboxHistory),
        db.getRepository(Shift),
        {} as never,
        {} as never,
        {} as never,
        db.getRepository(FinancialBalanceHistory),
        db,
        { log: jest.fn() } as never,
        { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
        { send: jest.fn(() => of({})) } as never,
        identityClient as never,
        { enqueue: jest.fn() } as never,
      );
      daily = new FinanceDailyService(db);

      const makeBox = async (user_id: string, cashbox_type: Cashbox_type) =>
        String(
          (
            await db.getRepository(Cashbox).save(
              db.getRepository(Cashbox).create({
                user_id,
                cashbox_type,
                balance: 0,
                balance_cash: 0,
                balance_card: 0,
              }),
            )
          ).id,
        );
      box.main = await makeBox('0', Cashbox_type.MAIN);
      box.courier = await makeBox(COURIER, Cashbox_type.FOR_COURIER);
      box.market = await makeBox(MARKET, Cashbox_type.FOR_MARKET);
      box.branch = await makeBox(BRANCH, Cashbox_type.BRANCH);

      const card = async (
        cashbox_id: string,
        name: string,
        is_default: boolean,
        is_active = true,
      ) =>
        String(
          (
            await db.getRepository(CashboxCard).save(
              db.getRepository(CashboxCard).create({
                cashbox_id,
                name,
                balance: 0,
                is_default,
                is_active,
              }),
            )
          ).id,
        );
      defaultCardId = await card(box.main, 'Asosiy karta', true);
      namedCardId = await card(box.main, 'Humo', false);
      archivedCardId = await card(box.main, 'Eski karta', false, false);
      // Filialning eski (63HO6cBU dan oldingi) Asosiy kartasi — filial qatorlari baribir kartasiz.
      await card(box.branch, 'Asosiy karta', true);

      const yesterday = new Date(Date.now() - 36 * 3600 * 1000);
      const row = async (
        key: string,
        cashbox: string,
        operation_type: Operation_type,
        source_type: Source_type,
        amount: number,
        payment_method: PaymentMethod,
        extra: Partial<CashboxHistory> = {},
      ) => {
        const saved = await db.getRepository(CashboxHistory).save(
          db.getRepository(CashboxHistory).create({
            cashbox_id: cashbox,
            operation_type,
            source_type,
            amount,
            balance_after: 0,
            payment_method,
            ...extra,
          }),
        );
        ids[key] = String(saved.id);
      };
      const t1 = randomUUID();
      const t2 = randomUUID();
      const t3 = randomUUID();
      const t4 = randomUUID();
      const t5 = randomUUID();
      const t6 = randomUUID();
      // Kuryer → HQ: naqd (t1), Asosiy kartaga (t2, card_id yo'q), «Humo» ga (t3).
      await row(
        'mainCash',
        box.main,
        Operation_type.INCOME,
        Source_type.COURIER_PAYMENT,
        100,
        PaymentMethod.CASH,
        { transfer_id: t1, source_user_id: COURIER },
      );
      await row(
        'courierCash',
        box.courier,
        Operation_type.EXPENSE,
        Source_type.COURIER_PAYMENT,
        100,
        PaymentMethod.CASH,
        { transfer_id: t1, source_user_id: COURIER },
      );
      await row(
        'mainDefault',
        box.main,
        Operation_type.INCOME,
        Source_type.COURIER_PAYMENT,
        200,
        PaymentMethod.CLICK,
        { transfer_id: t2, source_user_id: COURIER },
      );
      await row(
        'courierDefault',
        box.courier,
        Operation_type.EXPENSE,
        Source_type.COURIER_PAYMENT,
        200,
        PaymentMethod.CLICK,
        { transfer_id: t2, source_user_id: COURIER },
      );
      await row(
        'mainNamed',
        box.main,
        Operation_type.INCOME,
        Source_type.COURIER_PAYMENT,
        300,
        PaymentMethod.CLICK,
        { transfer_id: t3, card_id: namedCardId, source_user_id: COURIER },
      );
      await row(
        'courierNamed',
        box.courier,
        Operation_type.EXPENSE,
        Source_type.COURIER_PAYMENT,
        300,
        PaymentMethod.CLICK,
        { transfer_id: t3, source_user_id: COURIER },
      );
      // Kuryer → market «Marketga o'tkazma» (HQ qatori bilan, kartasiz).
      await row(
        'mainToMarket',
        box.main,
        Operation_type.INCOME,
        Source_type.COURIER_PAYMENT,
        400,
        PaymentMethod.CLICK_TO_MARKET,
        { transfer_id: t4, source_user_id: COURIER },
      );
      await row(
        'courierToMarket',
        box.courier,
        Operation_type.EXPENSE,
        Source_type.COURIER_PAYMENT,
        400,
        PaymentMethod.CLICK_TO_MARKET,
        { transfer_id: t4, source_user_id: COURIER },
      );
      // HQ → market «Humo» dan (t5) va naqd (t6).
      await row(
        'mainPayMarket',
        box.main,
        Operation_type.EXPENSE,
        Source_type.MARKET_PAYMENT,
        500,
        PaymentMethod.CLICK,
        { transfer_id: t5, card_id: namedCardId, source_user_id: MARKET },
      );
      await row(
        'marketNamed',
        box.market,
        Operation_type.EXPENSE,
        Source_type.MARKET_PAYMENT,
        500,
        PaymentMethod.CLICK,
        { transfer_id: t5, source_user_id: MARKET },
      );
      await row(
        'mainPayMarketCash',
        box.main,
        Operation_type.EXPENSE,
        Source_type.MARKET_PAYMENT,
        600,
        PaymentMethod.CASH,
        { transfer_id: t6, source_user_id: MARKET },
      );
      await row(
        'marketCash',
        box.market,
        Operation_type.EXPENSE,
        Source_type.MARKET_PAYMENT,
        600,
        PaymentMethod.CASH,
        { transfer_id: t6, source_user_id: MARKET },
      );
      // Qo'lda: kecha «Eski karta» dan chiqim (arxivlangan karta ham topiladi), naqd kirim.
      await row(
        'mainArchived',
        box.main,
        Operation_type.EXPENSE,
        Source_type.MANUAL_EXPENSE,
        700,
        PaymentMethod.CLICK,
        {
          card_id: archivedCardId,
          createdAt: yesterday,
          created_by: '9',
        },
      );
      await row(
        'mainManualCash',
        box.main,
        Operation_type.INCOME,
        Source_type.MANUAL_INCOME,
        800,
        PaymentMethod.CASH,
      );
      // Filial kassasi: naqd va (eski FE) click — filialda karta yo'q.
      await row(
        'branchCash',
        box.branch,
        Operation_type.INCOME,
        Source_type.COURIER_PAYMENT,
        900,
        PaymentMethod.CASH,
      );
      await row(
        'branchClick',
        box.branch,
        Operation_type.INCOME,
        Source_type.COURIER_PAYMENT,
        1000,
        PaymentMethod.CLICK,
      );
      // O'chirilgan qator hech qachon chiqmaydi.
      await row(
        'mainDeleted',
        box.main,
        Operation_type.INCOME,
        Source_type.MANUAL_INCOME,
        1100,
        PaymentMethod.CASH,
        { isDeleted: true },
      );
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    const history = async (query: Record<string, unknown>) =>
      (await service.findAllHistory(query)) as any;
    const keysOf = (response: any) =>
      (response.data.items as Array<{ id: string }>)
        .map((item) =>
          Object.keys(ids).find((key) => ids[key] === String(item.id)),
        )
        .sort();
    const main = { cashbox_type: Cashbox_type.MAIN };

    it('payment_method=cash — faqat naqd; counts va pagination.total filtrdan keyin', async () => {
      const response = await history({ ...main, payment_method: 'cash' });
      expect(keysOf(response)).toEqual(
        ['mainCash', 'mainManualCash', 'mainPayMarketCash'].sort(),
      );
      expect(response.data.pagination.total).toBe(3);
      expect(response.data.counts).toEqual({ all: 3, income: 2, expense: 1 });
    });

    it('payment_method=cash,click — ikkalasi (YOKI); click_to_market — alohida', async () => {
      const both = await history({ ...main, payment_method: 'cash,click' });
      expect(both.data.pagination.total).toBe(7);
      expect(keysOf(both)).not.toContain('mainToMarket');
      const toMarket = await history({
        ...main,
        payment_method: 'click_to_market',
      });
      expect(keysOf(toMarket)).toEqual(['mainToMarket']);
      // Takrorlangan parametr (massiv) va katta harf ham.
      const asArray = await history({
        ...main,
        payment_method: ['CASH', 'click_to_market'],
      });
      expect(asArray.data.pagination.total).toBe(4);
    });

    it('payment_method=none — usuli bo`sh qatorlar (ustun NOT NULL — bo`sh ro`yxat, xato emas)', async () => {
      const none = await history({ ...main, payment_method: 'none' });
      expect(none.data.items).toEqual([]);
      expect(none.data.pagination.total).toBe(0);
      const withCash = await history({ ...main, payment_method: 'none,cash' });
      expect(withCash.data.pagination.total).toBe(3);
    });

    it('boshqa filtrlar bilan AND: operation_type, sana, cashbox_type', async () => {
      const income = await history({
        ...main,
        payment_method: 'cash',
        operation_type: Operation_type.INCOME,
      });
      expect(keysOf(income)).toEqual(['mainCash', 'mainManualCash'].sort());
      expect(income.data.counts).toEqual({ all: 3, income: 2, expense: 1 });

      // Toshkent kuni (UTC+5) — qatorlar hozir yozilgan, «Eski karta» qatori 36 soat oldin.
      const today = new Date(Date.now() + 5 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const todayOnly = await history({
        ...main,
        payment_method: 'click',
        from_date: today,
        to_date: today,
      });
      expect(keysOf(todayOnly)).not.toContain('mainArchived');
      expect(keysOf(todayOnly)).toEqual(
        ['mainDefault', 'mainNamed', 'mainPayMarket'].sort(),
      );

      const couriers = await history({
        cashbox_type: Cashbox_type.FOR_COURIER,
        payment_method: 'click',
      });
      expect(keysOf(couriers)).toEqual(
        ['courierDefault', 'courierNamed'].sort(),
      );
    });

    it('card_id=<nomli karta> — o`sha karta qatorlari; arxivlangan karta ham', async () => {
      const named = await history({ ...main, card_id: namedCardId });
      expect(keysOf(named)).toEqual(['mainNamed', 'mainPayMarket'].sort());
      expect(named.data.counts).toEqual({ all: 2, income: 1, expense: 1 });
      const archived = await history({ ...main, card_id: archivedCardId });
      expect(keysOf(archived)).toEqual(['mainArchived']);
    });

    it('card_id=<Asosiy karta> — `card_id` siz click qatorlari (tafsilotdagi «Asosiy karta»)', async () => {
      const def = await history({ ...main, card_id: defaultCardId });
      expect(keysOf(def)).toEqual(['mainDefault']);
      const several = await history({
        ...main,
        card_id: `${defaultCardId},${namedCardId}`,
      });
      expect(several.data.pagination.total).toBe(3);
    });

    it('card_id=none — kartasiz: naqd va «Marketga o`tkazma»', async () => {
      const none = await history({ ...main, card_id: 'none' });
      expect(keysOf(none)).toEqual(
        [
          'mainCash',
          'mainManualCash',
          'mainPayMarketCash',
          'mainToMarket',
        ].sort(),
      );
      const noneOrNamed = await history({
        ...main,
        card_id: `none,${namedCardId}`,
      });
      expect(noneOrNamed.data.pagination.total).toBe(6);
    });

    it('kuryer va market kassasi: o`tkazmaning HQ qatoridagi karta bo`yicha', async () => {
      const courier = {
        user_id: COURIER,
        cashbox_type: Cashbox_type.FOR_COURIER,
      };
      expect(
        keysOf(await history({ ...courier, card_id: namedCardId })),
      ).toEqual(['courierNamed']);
      expect(
        keysOf(await history({ ...courier, card_id: defaultCardId })),
      ).toEqual(['courierDefault']);
      expect(keysOf(await history({ ...courier, card_id: 'none' }))).toEqual(
        ['courierCash', 'courierToMarket'].sort(),
      );

      const market = { user_id: MARKET, cashbox_type: Cashbox_type.FOR_MARKET };
      expect(
        keysOf(await history({ ...market, card_id: namedCardId })),
      ).toEqual(['marketNamed']);
      expect(keysOf(await history({ ...market, card_id: 'none' }))).toEqual([
        'marketCash',
      ]);
      expect(
        keysOf(await history({ ...market, card_id: defaultCardId })),
      ).toEqual([]);
    });

    it('filial kassasi: karta yo`q (63HO6cBU) — hamma qator `none`', async () => {
      const branch = { user_id: BRANCH, cashbox_type: Cashbox_type.BRANCH };
      expect(keysOf(await history({ ...branch, card_id: 'none' }))).toEqual(
        ['branchCash', 'branchClick'].sort(),
      );
      const branchDefault = (
        await db
          .getRepository(CashboxCard)
          .findOneByOrFail({ cashbox_id: box.branch })
      ).id;
      expect(
        keysOf(await history({ ...branch, card_id: String(branchDefault) })),
      ).toEqual([]);
      expect(
        keysOf(await history({ ...branch, payment_method: 'click' })),
      ).toEqual(['branchClick']);
    });

    it('chek holati bilan birga (`id` ustunida And)', async () => {
      const response = await history({
        ...main,
        receipt_status: 'none',
        card_id: namedCardId,
      });
      expect(keysOf(response)).toEqual(['mainNamed']);
      const def = await history({
        ...main,
        receipt_status: 'none',
        card_id: defaultCardId,
      });
      expect(keysOf(def)).toEqual(['mainDefault']);
    });

    it('noma`lum qiymat → 400', async () => {
      expect(
        await errorBody(history({ ...main, payment_method: 'card' })),
      ).toMatchObject({ statusCode: 400 });
      expect(
        await errorBody(history({ ...main, payment_method: 'cash,payme' })),
      ).toMatchObject({ statusCode: 400 });
      expect(
        await errorBody(history({ ...main, card_id: 'abc' })),
      ).toMatchObject({ statusCode: 400 });
      expect(
        await errorBody(history({ ...main, card_id: '1'.repeat(25) })),
      ).toMatchObject({ statusCode: 400 });
      expect(
        await errorBody(history({ ...main, payment_method: { x: 1 } })),
      ).toMatchObject({ statusCode: 400 });
    });

    it('GET /finance/cashbox/user/:id tarixi — AYNI filtr, `pagination.total` filtrdan keyin', async () => {
      const response: any = await service.findCashboxByUser({
        user_id: COURIER,
        cashbox_type: Cashbox_type.FOR_COURIER,
        with_history: true,
        page: 1,
        limit: 100,
        payment_method: 'click',
        card_id: namedCardId,
      });
      expect(response.data.history.map((item: any) => String(item.id))).toEqual(
        [ids.courierNamed],
      );
      expect(response.data.pagination.total).toBe(1);

      const untyped: any = await service.findCashboxByUser({
        user_id: MARKET,
        with_history: true,
        page: 1,
        limit: 100,
        card_id: 'none',
      });
      expect(untyped.data.history.map((item: any) => String(item.id))).toEqual([
        ids.marketCash,
      ]);
    });

    it('history/daily — AYNI filtr (kunlik jami filtrdan keyin), noma`lum → 400', async () => {
      const day = (await daily.historyDaily({
        cashbox_type: 'main',
        payment_method: 'cash',
      })) as any;
      const data = day.data ?? day;
      expect(data.filtered).toBe(true);
      expect(data.totals).toMatchObject({
        income: 900,
        expense: 600,
        income_count: 2,
        expense_count: 1,
      });

      const card = (await daily.historyDaily({
        cashbox_type: 'main',
        card_id: defaultCardId,
      })) as any;
      expect((card.data ?? card).totals).toMatchObject({
        income: 200,
        expense: 0,
      });

      await expect(
        daily.historyDaily({ cashbox_type: 'main', payment_method: 'bank' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  },
);
