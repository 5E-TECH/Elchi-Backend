import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  ActivityLog,
  ActivityLogService,
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxExpenseCategory } from './entities/cashbox-expense-category.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinanceSetting } from './entities/finance-setting.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { PaymentCorrection } from './entities/payment-correction.entity';
import { Shift } from './entities/shift.entity';
import { FinanceNotificationService } from './notification/finance-notification.service';

/**
 * 2026-11-15 (prod, Toshkent Shahar filiali #11): HQ asosiy kassasidan id'si
 * 11 bo'lgan marketga 4 000 000 to'lov filial 11 tarixida «Market to'lovi»
 * bo'lib chiqdi. Sabab: filial sahifasi asosiy kassa qatorlarini
 * `source_user_id=<filial id>` bilan olardi, bu ustunda esa market/kuryer
 * (foydalanuvchi) id'lari ham turadi — filial id'lari alohida sanaladi.
 * `source_branch_id` — faqat `branch_to_main` va UNI qaytargan
 * `payment_reversal`. HAQIQIY Postgres (FINANCE_PG_TEST_URI bo'lmasa skip;
 * o'z vaqtinchalik bazasi).
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type HistoryPage = {
  data: {
    items: Array<{ id: string; source_type: string }>;
    counts: { all: number; income: number; expense: number };
    pagination: { total: number };
  };
};

describePg('filial tarixi: source_branch_id — haqiqiy Postgres', () => {
  const dbName = `spec_hbs_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    const entities = [
      Cashbox,
      CashboxHistory,
      CashboxCard,
      CashboxExpenseCategory,
      FinancialBalanceHistory,
      FinanceSetting,
      Shift,
      ActivityLog,
      PaymentCorrection,
    ];
    const bootstrap = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities,
      synchronize: false,
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA finance_schema');
    await bootstrap.synchronize();
    await bootstrap.destroy();
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities,
      synchronize: false,
    });
    await db.initialize();
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const identityClient = {
      send: jest.fn((_p: { cmd: string }, payload: any) =>
        of({
          data: Array.isArray(payload?.ids)
            ? payload.ids.map((id: string) => ({ id, name: `U-${id}` }))
            : { id: payload?.id, name: `U-${payload?.id}` },
        }),
      ),
    };
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      new ActivityLogService(db.getRepository(ActivityLog), 'finance-service'),
      { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
      { send: jest.fn(() => of({})) } as never,
      identityClient as never,
      outbox as never,
      new FinanceNotificationService(outbox as never),
    );

    // Kassalar: HQ (MAIN), filial 11 (BRANCH), market 11 (FOR_MARKET) —
    // filial va market id'lari bir xil (ikki xil ketma-ketlik).
    const cashbox = async (user_id: string, cashbox_type: Cashbox_type) =>
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
    const main = await cashbox('0', Cashbox_type.MAIN);
    const branch11 = await cashbox('11', Cashbox_type.BRANCH);
    const market11 = await cashbox('11', Cashbox_type.FOR_MARKET);

    const row = async (
      key: string,
      cashbox_id: string,
      source_type: Source_type,
      operation_type: Operation_type,
      source_user_id: string,
      reverses?: string,
    ) => {
      const saved = await db.getRepository(CashboxHistory).save(
        db.getRepository(CashboxHistory).create({
          cashbox_id,
          source_type,
          operation_type,
          source_user_id,
          reverses_history_id: reverses ? ids[reverses] : null,
          amount: 4_000_000,
          balance_after: 0,
          payment_method: PaymentMethod.CLICK,
          created_by: '7',
        }),
      );
      ids[key] = String(saved.id);
    };
    // Filial 11 → HQ: filial chiqimi + HQ kirimi.
    await row(
      'b2mBranch',
      branch11,
      Source_type.BRANCH_TO_MAIN,
      Operation_type.EXPENSE,
      '11',
    );
    await row(
      'b2mMain',
      main,
      Source_type.BRANCH_TO_MAIN,
      Operation_type.INCOME,
      '11',
    );
    // HQ → market 11 (prod holati): HQ chiqimi + market qatori.
    await row(
      'mpMain',
      main,
      Source_type.MARKET_PAYMENT,
      Operation_type.EXPENSE,
      '11',
    );
    await row(
      'mpMarket',
      market11,
      Source_type.MARKET_PAYMENT,
      Operation_type.EXPENSE,
      '11',
    );
    // T6 teskari yozuvlar (manba asl oyoqdan ko'chiriladi).
    await row(
      'mpReversal',
      main,
      Source_type.PAYMENT_REVERSAL,
      Operation_type.INCOME,
      '11',
      'mpMain',
    );
    await row(
      'b2mReversal',
      main,
      Source_type.PAYMENT_REVERSAL,
      Operation_type.EXPENSE,
      '11',
      'b2mMain',
    );
    // Boshqa filial (12) → HQ.
    await row(
      'b2mOther',
      main,
      Source_type.BRANCH_TO_MAIN,
      Operation_type.INCOME,
      '12',
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  const list = async (dto: Record<string, unknown>) => {
    const res = (await finance.findAllHistory(dto)) as HistoryPage;
    return {
      ids: res.data.items.map((item) => String(item.id)).sort(),
      counts: res.data.counts,
      total: res.data.pagination.total,
    };
  };
  const pick = (...keys: string[]) => keys.map((key) => ids[key]).sort();

  it('⭐ HQ asosiy kassasi, filial 11: faqat filial → HQ va uning teskari yozuvi; id 11 li marketga to`lov va uning qaytarilishi YO`Q', async () => {
    const result = await list({ source_branch_id: '11', cashbox_type: 'main' });
    expect(result.ids).toEqual(pick('b2mMain', 'b2mReversal'));
    expect(result.counts).toEqual({ all: 2, income: 1, expense: 1 });
    expect(result.total).toBe(2);
  });

  it('eski `source_user_id=11` o`zgarmagan: market to`lovi ham keladi (id to`qnashuvi — shu sabab filial sahifasi endi source_branch_id ishlatadi)', async () => {
    const result = await list({ source_user_id: '11', cashbox_type: 'main' });
    expect(result.ids).toEqual(
      pick('b2mMain', 'mpMain', 'mpReversal', 'b2mReversal'),
    );
  });

  it('«To`lov o`tkazmalari» tabi turlari bilan kesishadi; faqat market turi so`ralsa — bo`sh', async () => {
    const payments = await list({
      source_branch_id: '11',
      cashbox_type: 'main',
      source_types:
        'courier_payment,market_payment,branch_to_main,payment_reversal',
    });
    expect(payments.ids).toEqual(pick('b2mMain', 'b2mReversal'));

    const onlyB2m = await list({
      source_branch_id: '11',
      cashbox_type: 'main',
      source_type: Source_type.BRANCH_TO_MAIN,
    });
    expect(onlyB2m.ids).toEqual(pick('b2mMain'));

    const marketOnly = await list({
      source_branch_id: '11',
      cashbox_type: 'main',
      source_types: 'market_payment',
    });
    expect(marketOnly).toEqual({
      ids: [],
      counts: { all: 0, income: 0, expense: 0 },
      total: 0,
    });
  });

  it('kassa tanlovisiz — filialning o`z oyog`i ham; boshqa filial (12) va market kassasi aralashmaydi; ziddiyatli source_user_id → bo`sh', async () => {
    const all = await list({ source_branch_id: '11' });
    expect(all.ids).toEqual(pick('b2mBranch', 'b2mMain', 'b2mReversal'));

    const other = await list({ source_branch_id: '12', cashbox_type: 'main' });
    expect(other.ids).toEqual(pick('b2mOther'));

    const conflict = await list({
      source_branch_id: '11',
      source_user_id: '12',
    });
    expect(conflict.total).toBe(0);
  });
});
